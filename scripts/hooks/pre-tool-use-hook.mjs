#!/usr/bin/env node
// pre-tool-use-hook.mjs — block recursive claude-rescue dispatch from inside a child run.
//
// When the companion spawns a child claude, it sets CLAUDE_RESCUE_DEPTH > 0 in the
// child's env. Any tool call inherited by that child also sees that env, including
// hook invocations. We use that signal to refuse:
//   - Agent(subagent_type="claude-rescue")
//   - Bash invocations that re-enter the companion CLI (claude-companion.mjs task / startJob)
//
// This is enforcement-at-the-edge so the user gets a clear deny *before* a child
// burns time spawning grandchildren. The companion's assertDepthOk() stays as a
// runtime backstop for callers that bypass Claude Code (raw node invocations).

import fs from 'fs';
import process from 'process';

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function currentDepth() {
  return parseInt(process.env.CLAUDE_RESCUE_DEPTH || '0', 10);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function main() {
  const depth = currentDepth();
  if (depth <= 0) return; // top-level Claude — nothing to block.

  const input = readHookInput();
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName === 'Agent') {
    const sub = toolInput.subagent_type || '';
    if (sub === 'claude-rescue') {
      deny(
        `claude-rescue nesting is disabled (current depth=${depth}). ` +
        `You are already running inside a dispatched claude-rescue child — ` +
        `complete the task here instead of dispatching another level. ` +
        `If you genuinely need recursion, the operator must opt in with ` +
        `CLAUDE_RESCUE_ALLOW_NESTING=1.`,
      );
    }
    return;
  }

  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    // Match the companion entry-point being invoked as a task/startJob, regardless of
    // how it's wrapped (secret-run, env, full path, etc.).
    const looksLikeCompanion = /claude-companion\.mjs/.test(cmd);
    const looksLikeDispatch = /\b(task|task-worker|start)\b/.test(cmd);
    if (looksLikeCompanion && looksLikeDispatch) {
      deny(
        `claude-rescue nesting is disabled (current depth=${depth}). ` +
        `Refusing to re-enter claude-companion.mjs from inside a child run. ` +
        `Operator opt-in: CLAUDE_RESCUE_ALLOW_NESTING=1.`,
      );
    }
  }
}

// Operator escape hatch — explicit opt-in only.
if (process.env.CLAUDE_RESCUE_ALLOW_NESTING === '1') {
  process.exit(0);
}

try {
  main();
} catch {
  // Never block tool use on hook crashes.
  process.exit(0);
}
