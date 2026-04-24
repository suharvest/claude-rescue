#!/usr/bin/env node
// session-lifecycle-hook.mjs — SessionStart banner, SessionEnd orphan reaping + tracking cleanup
// Session-scoped: banner shows only jobs for current session; SessionEnd clears tracking
// On SessionStart: propagates session_id via CLAUDE_ENV_FILE for subprocesses
import fs from 'fs';
import process from 'process';

import { reapOrphanedJobs, recentJobs } from '../lib/state.mjs';
import { listTrackedJobIds, clearSessionTracking, pruneMissing, SESSION_ID_ENV } from '../lib/tracked-jobs.mjs';

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Shell-escape a value for use in export statements: wrap in single quotes, escape internal '
function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Append export line to CLAUDE_ENV_FILE if set (CC hook protocol for env propagation)
function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === '') {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, 'utf8');
}

function formatElapsed(startValue, endValue = null) {
  const start = Date.parse(startValue);
  if (!Number.isFinite(start)) return '?';
  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) return '?';
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Filter recent jobs to only those tracked for the current session.
function filterJobsForSession(jobs, sessionId) {
  if (!sessionId) {
    // No session_id — fall back to global (backward compat)
    return jobs;
  }
  const trackedIds = listTrackedJobIds(sessionId);
  return jobs.filter(job => trackedIds.includes(job.id));
}

function handleSessionStart(input) {
  // Propagate session_id via CLAUDE_ENV_FILE for subprocesses (CC hook protocol)
  const sessionId = input.session_id || null;
  if (sessionId) {
    appendEnvVar(SESSION_ID_ENV, sessionId);
  }

  // Opportunistically reap orphaned jobs and prune missing tracking entries
  reapOrphanedJobs();
  pruneMissing();

  const jobs = recentJobs(5);

  // Apply session-scoped filtering
  const sessionJobs = filterJobsForSession(jobs, sessionId);

  if (sessionJobs.length === 0) return;

  const lines = ['<claude-rescue-session-banner>', 'Recent claude-rescue jobs for this session:'];
  for (const j of sessionJobs) {
    const elapsed = j.ended_at
      ? formatElapsed(j.started_at, j.ended_at)
      : `${formatElapsed(j.started_at)} (running)`;
    const preview = (j.prompt_preview || '').slice(0, 40);
    lines.push(`- ${j.id}: ${j.status} (${elapsed}) "${preview}"`);
  }
  lines.push('Check status: node scripts/claude-companion.mjs status');
  lines.push('</claude-rescue-session-banner>');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: lines.join('\n'),
      },
    }),
  );
}

function handleSessionEnd(input) {
  // Prefer input.session_id from stdin JSON (CC provides this reliably), fallback to env var
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (sessionId) {
    clearSessionTracking(sessionId);
  }

  const reaped = reapOrphanedJobs();
  if (reaped.length > 0) {
    process.stderr.write(`[claude-rescue] Session end: marked ${reaped.length} orphaned job(s)\n`);
  }
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? '';

  if (eventName === 'SessionStart') handleSessionStart(input);
  else if (eventName === 'SessionEnd') handleSessionEnd(input);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}