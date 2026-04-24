# Gaps vs codex-rescue / opencode-rescue

claude-rescue MVP is ~400 LOC. The reference plugins it's modeled on are ~5000 LOC. Here's what's intentionally missing and what it'd cost to add.

## Architecture: what's in, what's out

| Capability | codex-rescue | opencode-rescue | claude-rescue MVP |
|---|---|---|---|
| Thin forwarder subagent | ✓ | ✓ | ✓ |
| Spawn external CLI with custom env | ✓ | ✓ | ✓ |
| Job state dir (meta/log/stdout) | ✓ | ✓ | ✓ |
| Foreground + background modes | ✓ | ✓ | ✓ |
| `list-sources` / config introspection | — | — | ✓ (unique) |
| **Multi-backend routing** | — (GPT-5 only) | — (single model) | ✓ (unique) |
| `status` / `result` / `cancel` subcommands | ✓ | ✓ | partial (status/result, no cancel) |
| `review` / `adversarial-review` modes | ✓ | ✓ | — |
| `--resume-last` session continuity | ✓ | ✓ | — |
| Slash commands (`/rescue`, `/status`, ...) | ✓ | ✓ | — |
| Session lifecycle hooks | ✓ | ✓ | — |
| Post-tool-use monitor hook | ✓ | ✓ | — |
| App-server broker (for streaming progress) | ✓ | — | — |
| Structured render / pretty-print | ✓ | ✓ | — (raw stream-json) |
| Stop-review-gate integration | ✓ | ✓ | — |
| Skills (runtime contract, prompting) | ✓ | ✓ | — |
| Git worktree isolation | — | — | — |
| MCP passthrough | inherited | inherited | inherited |

## What to add next (ranked by value)

### P0 — user-facing polish (low effort, high value)

1. **`cancel` subcommand** — kill a background job by id. ~30 LOC.
2. **Render helper** — parse stream-json, print only assistant text + tool calls in foreground mode. Current behavior dumps raw JSONL, which is hard to read. ~80 LOC (port a trimmed version of codex-rescue's `render.mjs`).
3. **`--resume <job-id>`** — pass `--resume <session-id>` through to the `claude` CLI so follow-up dispatches share context. ~20 LOC; depends on whether Claude Code's `-p` mode honors `--resume` (needs testing).
4. **Slash commands** — `/rescue`, `/rescue-status`, `/rescue-result`. Each is a thin markdown file under `commands/`. ~50 LOC total.

### P1 — ergonomics

5. **Progress streaming** — instead of blocking foreground run, emit a "job started + tail" pattern so main thread can poll without reading full log. ~100 LOC (inspired by opencode's `Monitor` integration).
6. **`auto` source selection** — if user doesn't specify `source=`, pick based on task heuristics (code-heavy → qwen3-coder, reasoning → deepseek-pro, vision → qwen3.6-plus). ~60 LOC + prompt engineering in the agent md.
7. **Cost estimation** — maintain a `costs.json` with per-provider rates; companion prints `~$0.02 estimated` after each run based on token counts in stream-json. ~80 LOC.

### P2 — resilience

8. **Timeout + retry** — per-source timeout config; auto-retry on transient 5xx. ~60 LOC.
9. **Fallback chain** — if primary source fails, fall through to next source in a list. ~40 LOC.
10. **Backend health check** — `claude-companion health` pings each source's `/v1/messages` with a 1-token probe. ~60 LOC.

### P3 — nice-to-have

11. **Web UI for job list** — small `server.js` serving job dir at localhost:9999. ~150 LOC.
12. **Token usage dashboard** — aggregate `stream-json` usage events by source/day. ~100 LOC.
13. **Plugin-marketplace publishing** — proper `plugin.json` + marketplace manifest. ~5 LOC.

## What's explicitly NOT planned

- **Agent-side reasoning / review loops** (codex has review mode). Out of scope: claude-rescue is a dispatcher, not a reviewer. Use `/review` or `codex-rescue` for that.
- **Broker / server-mode runtime**. The 252-line `app-server-broker.mjs` in codex exists because Codex's CLI needs a long-lived app-server; `claude -p` is one-shot, so we don't need it.
- **MCP server bundling**. Inherited from the spawned `claude` process's own MCP config; no need to duplicate.
