// lib/tracked-jobs.mjs — per-session job tracking for claude-rescue
// Stores mapping in ~/.claude/plugins/data/claude-rescue/tracked-jobs.json
// Format: { "<sessionId>": ["jobId1", "jobId2", ...] }
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, writeSync, unlinkSync, statSync } from 'fs';
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

// Detect a stale lock by inspecting the holder pid (and mtime as fallback).
// Returns true if the lock was removed.
function tryRemoveStaleLock(lock) {
  try {
    const raw = readFileSync(lock, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // probe; throws ESRCH if dead, EPERM if alive but not ours
      } catch (err) {
        if (err.code === 'ESRCH') {
          unlinkSync(lock);
          return true;
        }
      }
    }
    // Fallback: age-based eviction (e.g. lock file with no pid, or alien holder)
    const st = statSync(lock);
    if (Date.now() - st.mtimeMs > 30_000) {
      unlinkSync(lock);
      return true;
    }
  } catch {}
  return false;
}

function withLock(fn) {
  const lock = lockFile();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let fd;
    try {
      fd = openSync(lock, 'wx'); // exclusive create
    } catch (e) {
      if (e.code === 'EEXIST') {
        if (tryRemoveStaleLock(lock)) continue;
        const end = Date.now() + 20 + Math.floor(Math.random() * 30);
        while (Date.now() < end) {}
        continue;
      }
      throw e;
    }
    try {
      writeSync(fd, String(process.pid));
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