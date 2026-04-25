# Gaps vs codex-rescue / opencode-rescue

claude-rescue v1.0 is ~450 LOC with full lifecycle support. The reference plugins are ~5000 LOC. Here's what's intentionally missing and what it'd cost to add.

## Architecture: what's in, what's out

| Capability | codex-rescue | opencode-rescue | claude-rescue v1.0 |
|---|---|---|---|
| Thin forwarder subagent | ✓ | ✓ | ✓ |
| Spawn external CLI with custom env | ✓ | ✓ | ✓ |
| Job state dir (meta/log/stdout) | ✓ | ✓ | ✓ |
| Foreground + background modes | ✓ | ✓ | ✓ |
| `list-sources` / config introspection | — | — | ✓ (unique) |
| **Multi-backend routing** | — (GPT-5 only) | — (single model) | ✓ (unique) |
| `status` / `result` / `cancel` subcommands | ✓ | ✓ | ✓ (all three) |
| Slash commands (`/rescue`, `/status`, ...) | ✓ | ✓ | ✓ (5 commands) |
| Session lifecycle hooks | ✓ | ✓ | ✓ (Stop, PostToolUse, SessionStart, SessionEnd) |
| Structured render / pretty-print | ✓ | ✓ | ✓ (stream-json renderer) |
| Stop-review-gate integration | ✓ | ✓ | ✓ |
| Per-session job tracking | — | — | ✓ (unique) |
| `--resume` passthrough | ✓ | ✓ | ✓ |
| Double-fork worker pattern | — | — | ✓ (worker-owned cancel) |
| `review` / `adversarial-review` modes | ✓ | ✓ | — (non-goal) |
| App-server broker (for streaming progress) | ✓ | — | — (non-goal) |
| Skills (runtime contract, prompting) | ✓ | ✓ | — (non-goal) |
| Git worktree isolation | — | — | — (non-goal) |
| MCP passthrough | inherited | inherited | inherited |

## What's explicitly NOT planned (non-goals)

- **Agent-side reasoning / review loops** (codex has review mode). Out of scope: claude-rescue is a dispatcher, not a reviewer. Use `/review` or `codex-rescue` for that.
- **Broker / server-mode runtime**. The 252-line `app-server-broker.mjs` in codex exists because Codex's CLI needs a long-lived app-server; `claude -p` is one-shot, so we don't need it.
- **MCP server bundling**. Inherited from the spawned `claude` process's own MCP config; no need to duplicate.

## What to add next (ranked by value)

### P1 — ergonomics

1. **Progress streaming** — instead of blocking foreground run, emit a "job started + tail" pattern so main thread can poll without reading full log. ~100 LOC (inspired by opencode's `Monitor` integration).
2. **`auto` source selection** — if user doesn't specify `source=`, pick based on task heuristics (code-heavy → qwen3-coder, reasoning → deepseek-pro, vision → qwen3.6-plus). ~60 LOC + prompt engineering in the agent md.
3. **Cost estimation** — maintain a `costs.json` with per-provider rates; companion prints `~$0.02 estimated` after each run based on token counts in stream-json. ~80 LOC.

### P2 — resilience

4. **Timeout + retry** — per-source timeout config; auto-retry on transient 5xx. ~60 LOC.
5. **Fallback chain** — if primary source fails, fall through to next source in a list. ~40 LOC.
6. **Backend health check** — `claude-companion health` pings each source's `/v1/messages` with a 1-token probe. ~60 LOC.

### P3 — nice-to-have

7. **Web UI for job list** — small `server.js` serving job dir at localhost:9999. ~150 LOC.
8. **Token usage dashboard** — aggregate `stream-json` usage events by source/day. ~100 LOC.
9. **Plugin-marketplace publishing** — proper `plugin.json` + marketplace manifest. ~5 LOC.