#!/usr/bin/env node
// post-tool-use-hook.mjs — invoked after Agent/Bash calls, surfaces running jobs status
import fs from 'fs';
import process from 'process';
import { fileURLToPath } from 'url';

import { listRunningJobs } from '../lib/state.mjs';

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

function main() {
  const input = readHookInput();
  const toolName = input.tool_name || '';
  if (toolName !== 'Agent' && toolName !== 'Bash') return;

  const runningJobs = listRunningJobs();
  if (runningJobs.length === 0) return;

  const summaries = runningJobs.map(j => {
    const elapsed = formatElapsed(j.started_at);
    const model = j.model || 'default';
    return `${j.id} (${j.source}/${model}, ${elapsed})`;
  });

  const additionalContext = [
    '<claude-rescue-running-jobs>',
    `claude-rescue has ${runningJobs.length} job(s) running: ${summaries.join(', ')}.`,
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