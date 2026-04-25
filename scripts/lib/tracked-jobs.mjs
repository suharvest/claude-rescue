// lib/tracked-jobs.mjs — per-session job tracking for claude-rescue
// Stores mapping in ~/.claude/plugins/data/claude-rescue/tracked-jobs.json
// Format: { "<sessionId>": ["jobId1", "jobId2", ...] }
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { stateRoot, readJobMeta, validateSessionId, validateJobId } from './state.mjs';

export const SESSION_ID_ENV = 'CLAUDE_RESCUE_SESSION_ID';

function trackedJobsFile() {
  return join(stateRoot(), 'tracked-jobs.json');
}

function lockFile() {
  return join(stateRoot(), 'tracked-jobs.lock');
}

// Simple file-lock retry loop using exclusive create
function withLock(fn) {
  const lock = lockFile();
  for (let i = 0; i < 100; i++) {
    let fd;
    try {
      fd = openSync(lock, 'wx'); // exclusive create
    } catch (e) {
      if (e.code === 'EEXIST') {
        // Check stale: if older than 30s, force-remove
        try {
          const st = statSync(lock);
          if (Date.now() - st.mtimeMs > 30_000) {
            unlinkSync(lock);
          }
        } catch {}
        // Brief sleep (20-50ms)
        const end = Date.now() + 20 + Math.floor(Math.random() * 30);
        while (Date.now() < end) {}
        continue;
      }
      throw e;
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
  throw new Error('tracked-jobs lock timeout');
}

function readTrackedJobs() {
  const f = trackedJobsFile();
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeTrackedJobs(data) {
  const f = trackedJobsFile();
  const tmp = join(stateRoot(), `tracked-jobs.tmp.${process.pid}.${randomBytes(4).toString('hex')}.json`);
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, f);
}

// Track a job under a specific session.
export function trackJob(sessionId, jobId) {
  validateSessionId(sessionId);
  validateJobId(jobId);
  withLock(() => {
    const data = readTrackedJobs();
    if (!data[sessionId]) data[sessionId] = [];
    if (!data[sessionId].includes(jobId)) {
      data[sessionId].push(jobId);
    }
    writeTrackedJobs(data);
  });
}

// Remove a single job from a session's tracking.
export function untrackJob(sessionId, jobId) {
  validateSessionId(sessionId);
  validateJobId(jobId);
  withLock(() => {
    const data = readTrackedJobs();
    if (!data[sessionId]) return;
    const idx = data[sessionId].indexOf(jobId);
    if (idx >= 0) {
      data[sessionId].splice(idx, 1);
      if (data[sessionId].length === 0) {
        delete data[sessionId];
      }
      writeTrackedJobs(data);
    }
  });
}

// List all job IDs tracked under a specific session.
export function listTrackedJobIds(sessionId) {
  if (!sessionId) return [];
  validateSessionId(sessionId);
  return withLock(() => {
    const data = readTrackedJobs();
    return data[sessionId] || [];
  });
}

// Clear all tracking for a session (called on SessionEnd).
export function clearSessionTracking(sessionId) {
  if (!sessionId) return;
  validateSessionId(sessionId);
  withLock(() => {
    const data = readTrackedJobs();
    if (data[sessionId]) {
      delete data[sessionId];
      writeTrackedJobs(data);
    }
  });
}

// Prune jobIds whose meta.json no longer exists (cleanup).
export function pruneMissing() {
  withLock(() => {
    const data = readTrackedJobs();
    const cleaned = {};
    let changed = false;
    for (const [sessionId, jobIds] of Object.entries(data)) {
      const valid = jobIds.filter(jobId => {
        try {
          validateJobId(jobId);
          const meta = readJobMeta(jobId);
          return meta !== null;
        } catch {
          return false;
        }
      });
      if (valid.length > 0) {
        cleaned[sessionId] = valid;
      } else {
        changed = true;
      }
      if (valid.length !== jobIds.length) {
        changed = true;
      }
    }
    if (changed) {
      writeTrackedJobs(cleaned);
    }
  });
}