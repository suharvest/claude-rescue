#!/usr/bin/env node
// session-lifecycle-hook.mjs — SessionStart banner, SessionEnd orphan reaping
import fs from 'fs';
import process from 'process';

import { reapOrphanedJobs, recentJobs } from '../lib/state.mjs';

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
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

function handleSessionStart() {
  // Opportunistically reap orphaned jobs from previous sessions.
  reapOrphanedJobs();

  const jobs = recentJobs(5);
  if (jobs.length === 0) return;

  const lines = ['<claude-rescue-session-banner>', 'Recent claude-rescue jobs:'];
  for (const j of jobs) {
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

function handleSessionEnd() {
  const reaped = reapOrphanedJobs();
  if (reaped.length > 0) {
    process.stderr.write(`[claude-rescue] Session end: marked ${reaped.length} orphaned job(s)\n`);
  }
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? '';

  if (eventName === 'SessionStart') handleSessionStart();
  else if (eventName === 'SessionEnd') handleSessionEnd();
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
