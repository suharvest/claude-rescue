#!/usr/bin/env node
// post-tool-use-hook.mjs — invoked after Agent/Bash calls, surfaces running jobs status
// Session-scoped: only surfaces jobs tracked for the current session_id
import fs from 'fs';
import process from 'process';
import { fileURLToPath } from 'url';

import { listRunningJobs } from '../lib/state.mjs';
import { listTrackedJobIds, SESSION_ID_ENV } from '../lib/tracked-jobs.mjs';

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatElapsed(startValue) {
  const start = Date.parse(startValue);
  if (!Number.isFinite(start)) return '?';
  const end = Date.now();
  if (!Number.isFinite(end) || end < start) return '?';
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  if (totalSeconds >= 3600) return `${Math.floor(totalSeconds / 3600)}h`;
  if (totalSeconds >= 60) return `${Math.floor(totalSeconds / 60)}m`;
  return `${totalSeconds}s`;
}

// Filter running jobs to only those tracked for the current session.
function filterJobsForSession(runningJobs, sessionId) {
  if (!sessionId) {
    // No session_id — fall back to global scan (backward compat)
    return runningJobs;
  }
  const trackedIds = listTrackedJobIds(sessionId);
  return runningJobs.filter(job => trackedIds.includes(job.id));
}

function main() {
  const input = readHookInput();
  const toolName = input.tool_name || '';
  if (toolName !== 'Agent' && toolName !== 'Bash') return;

  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const runningJobs = listRunningJobs();

  // Apply session-scoped filtering
  const sessionJobs = filterJobsForSession(runningJobs, sessionId);

  if (sessionJobs.length === 0) return;

  const summaries = sessionJobs.map(j => {
    const elapsed = formatElapsed(j.started_at);
    const model = j.model || 'default';
    return `${j.id} (${j.source}/${model}, ${elapsed})`;
  });

  const additionalContext = [
    '<claude-rescue-running-jobs>',
    `claude-rescue has ${sessionJobs.length} job(s) running for this session: ${summaries.join(', ')}.`,
    'Check status: node scripts/claude-companion.mjs status',
    'Get result: node scripts/claude-companion.mjs result <job-id>',
    '</claude-rescue-running-jobs>',
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    }),
  );
}

try {
  main();
} catch {
  // Best-effort — never block tool use on hook failure.
  process.exit(0);
}