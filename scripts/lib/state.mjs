// lib/state.mjs — state directory layout for claude-rescue jobs
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

// Job ID format: YYYYMMDD-HHMMSS-hex (8 digits - 6 digits - 6 hex chars)
const JOB_ID_REGEX = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

// Session ID: alphanumeric + underscore/dash, max 128 chars
const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export function validateJobId(jobId) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error(`Invalid jobId: missing or not a string`);
  }
  if (!JOB_ID_REGEX.test(jobId)) {
    throw new Error(`Invalid jobId: "${jobId}" does not match expected format YYYYMMDD-HHMMSS-hex`);
  }
}

export function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error(`Invalid sessionId: missing or not a string`);
  }
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(`Invalid sessionId: "${sessionId}" contains invalid characters or is too long`);
  }
}

export function stateRoot() {
  return join(homedir(), '.claude', 'plugins', 'data', 'claude-rescue');
}

export function jobDir(jobId) {
  validateJobId(jobId);
  return join(stateRoot(), 'jobs', jobId);
}

export function newJobId() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = randomBytes(3).toString('hex');
  return `${date}-${time}-${hex}`;
}

export function ensureJobDir(jobId) {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJobMeta(jobId) {
  validateJobId(jobId);
  const metaPath = join(jobDir(jobId), 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    // Return null on parse failure so callers can skip malformed entries
    return null;
  }
}

export function listAllJobs() {
  const jobsDir = join(stateRoot(), 'jobs');
  if (!existsSync(jobsDir)) return [];
  // Filter out invalid job IDs (directory names not matching expected format)
  return readdirSync(jobsDir).filter(id => JOB_ID_REGEX.test(id));
}

export function sortJobsNewestFirst(jobIds) {
  // Job IDs are date-time based: YYYYMMDD-HHMMSS-hex
  // Sorting reverse alphabetically gives newest first
  return [...jobIds].sort().reverse();
}

export function listRunningJobs() {
  const allIds = listAllJobs();
  const running = [];
  for (const id of sortJobsNewestFirst(allIds)) {
    const meta = readJobMeta(id);
    if (meta && meta.status === 'running') {
      running.push({ id, ...meta });
    }
  }
  return running;
}

export function hooksStateFile() {
  return join(stateRoot(), 'hooks_state.json');
}

// Plugin config state file (stopReviewGate toggle, etc.)
export function pluginConfigFile() {
  return join(stateRoot(), 'state.json');
}

export function loadPluginConfig() {
  const f = pluginConfigFile();
  if (!existsSync(f)) return { config: { stopReviewGate: true } };
  try {
    return JSON.parse(readFileSync(f, 'utf8')) || { config: { stopReviewGate: true } };
  } catch {
    return { config: { stopReviewGate: true } };
  }
}

export function savePluginConfig(config) {
  const f = pluginConfigFile();
  const tmp = join(stateRoot(), `state.tmp.${process.pid}.${randomBytes(4).toString('hex')}.json`);
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  renameSync(tmp, f);
}

export function getConfig() {
  const state = loadPluginConfig();
  return state.config || { stopReviewGate: true };
}

export function setConfig(key, value) {
  const state = loadPluginConfig();
  if (!state.config) state.config = { stopReviewGate: true };
  state.config[key] = value;
  savePluginConfig(state);
}

export function loadHooksState() {
  const f = hooksStateFile();
  if (!existsSync(f)) return { announced: {} };
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return { announced: {} };
  }
}

export function saveHooksState(state) {
  const f = hooksStateFile();
  const tmp = join(stateRoot(), `hooks_state.tmp.${process.pid}.${randomBytes(4).toString('hex')}.json`);
  mkdirSync(stateRoot(), { recursive: true });
  const data = { announced: state.announced || {} };
  // Prune announced entries older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k of Object.keys(data.announced)) {
    if (data.announced[k].at < cutoff) delete data.announced[k];
  }
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, f);
}

// Write meta.json atomically for a specific job.
export function writeJobMeta(jobId, meta) {
  validateJobId(jobId);
  const dir = jobDir(jobId);
  const finalPath = join(dir, 'meta.json');
  const tmp = join(dir, `meta.tmp.${process.pid}.${randomBytes(4).toString('hex')}.json`);
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  renameSync(tmp, finalPath);
}

// Scan running-status jobs, verify each PID is alive; mark dead ones as orphaned.
// Returns the list of job IDs that were reaped this pass.
export function reapOrphanedJobs() {
  const reaped = [];
  for (const id of listAllJobs()) {
    const meta = readJobMeta(id);
    if (!meta || meta.status !== 'running' || !meta.pid) continue;
    try {
      process.kill(meta.pid, 0); // signal 0 = existence check only
    } catch (err) {
      if (err.code !== 'ESRCH') continue;
      meta.status = 'orphaned';
      meta.ended_at = new Date().toISOString();
      meta.exit_code = meta.exit_code ?? -1;
      writeJobMeta(id, meta);
      reaped.push(id);
    }
  }
  return reaped;
}

// Convenience: top-N recent jobs (newest first) with their metadata.
export function recentJobs(n = 5) {
  return sortJobsNewestFirst(listAllJobs())
    .slice(0, n)
    .map(id => ({ id, ...readJobMeta(id) }))
    .filter(j => j && j.status !== undefined);
}
