#!/usr/bin/env node
// stop-review-gate-hook.mjs — invoked on Stop event, blocks stop if jobs are running
// Session-scoped: only considers jobs tracked for the current session_id
// Respects config.stopReviewGate: if false, always allows stop
import fs from 'fs';
import process from 'process';

import { listRunningJobs, reapOrphanedJobs, getConfig } from '../lib/state.mjs';
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

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
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

function buildRunningJobsSummary(runningJobs) {
  const lines = [];
  for (const job of runningJobs) {
    const elapsed = formatElapsed(job.started_at);
    const preview = (job.prompt_preview || '').slice(0, 60);
    lines.push(`- ${job.id}: ${job.source}/${job.model || 'default'} (elapsed ${elapsed}) — "${preview}"`);
  }
  return lines.join('\n');
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
  // Check config: if stopReviewGate is disabled, always allow stop
  const config = getConfig();
  if (!config.stopReviewGate) {
    readHookInput(); // drain stdin per hook protocol
    emitDecision({});
    return;
  }

  // Prune dead running-status jobs before deciding — avoids false-positive blocks
  // when a previous session died without updating meta.
  reapOrphanedJobs();

  const input = readHookInput();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const runningJobs = listRunningJobs();

  // Apply session-scoped filtering
  const sessionJobs = filterJobsForSession(runningJobs, sessionId);

  if (sessionJobs.length === 0) {
    // No running jobs for this session — allow stop
    emitDecision({});
    return;
  }

  // There are running jobs for this session — block stop and surface them
  const summary = buildRunningJobsSummary(sessionJobs);

  const reason = [
    `Claude-rescue has ${sessionJobs.length} job(s) still running for this session:`,
    summary,
    '',
    'Check job status with: node scripts/claude-companion.mjs status',
    'Cancel a specific job with: node scripts/claude-companion.mjs cancel <job-id>',
    'Tail logs: tail -f ~/.claude/plugins/data/claude-rescue/jobs/<job-id>/stdout.log',
  ].join('\n');

  emitDecision({
    decision: 'block',
    reason,
  });
}

main();