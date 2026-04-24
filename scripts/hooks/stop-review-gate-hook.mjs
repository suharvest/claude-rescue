#!/usr/bin/env node
// stop-review-gate-hook.mjs — invoked on Stop event, blocks stop if jobs are running
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

import { listRunningJobs, reapOrphanedJobs } from '../lib/state.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function readHookInput() {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
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

function main() {
  // Prune dead running-status jobs before deciding — avoids false-positive blocks
  // when a previous session died without updating meta.
  reapOrphanedJobs();

  readHookInput(); // drain stdin per hook protocol
  const runningJobs = listRunningJobs();

  if (runningJobs.length === 0) {
    // No running jobs — allow stop
    emitDecision({});
    return;
  }

  // There are running jobs — block stop and surface them
  const summary = buildRunningJobsSummary(runningJobs);

  const reason = [
    `Claude-rescue has ${runningJobs.length} job(s) still running:`,
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

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}