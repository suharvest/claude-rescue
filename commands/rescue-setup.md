---
description: Check or toggle the stop-review-gate setting for claude-rescue
argument-hint: '[--enable|--disable|--toggle|--status]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs setup $ARGUMENTS"
```

The setup command manages the stop-review-gate configuration:

- `--status` (default): Shows current state and explains what stop-review-gate does
- `--enable`: Enables stop-review-gate (Stop events blocked if jobs running for this session)
- `--disable`: Disables stop-review-gate (Stop events always proceed without blocking)
- `--toggle`: Toggles between enabled and disabled

**What stop-review-gate does:**

When enabled (default), the hook blocks Stop events if there are claude-rescue jobs still running for the current session. This prevents accidentally ending a session while background jobs are active.

When disabled, Stop events always proceed immediately without checking for running jobs.

Output rules:
- Present the setup output to the user.
- Explain what the current/revised setting means for their workflow.