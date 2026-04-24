// lib/state.mjs — state directory layout for claude-rescue jobs
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export function stateRoot() {
  return join(homedir(), '.claude', 'plugins', 'data', 'claude-rescue');
}

export function jobDir(jobId) {
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
  const metaPath = join(jobDir(jobId), 'meta.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

export function listAllJobs() {
  const jobsDir = join(stateRoot(), 'jobs');
  if (!existsSync(jobsDir)) return [];
  return readdirSync(jobsDir);
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
  mkdirSync(stateRoot(), { recursive: true });
  const data = { announced: state.announced || {} };
  // Prune announced entries older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k of Object.keys(data.announced)) {
    if (data.announced[k].at < cutoff) delete data.announced[k];
  }
  writeFileSync(f, JSON.stringify(data, null, 2));
}

// Write meta.json atomically for a specific job.
function writeJobMeta(jobId, meta) {
  writeFileSync(join(jobDir(jobId), 'meta.json'), JSON.stringify(meta, null, 2));
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
