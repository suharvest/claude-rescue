# claude-rescue

> **One Claude Code conversation. Many models — official and not.**

Talk to Claude Code as usual. Within the same session, let it dispatch subtasks to DeepSeek, GLM, Qwen, Kimi, MiniMax, or any Anthropic-compatible backend — each call isolated in its own subprocess with its own key, endpoint, and model. Your main thread stays on your Pro/Max subscription and keeps full context; the heavy lifting goes elsewhere.

```
┌─────────────────────────────────────────────────────────────┐
│  You ⇄ Claude Code (Opus/Sonnet, your subscription)         │
│          │                                                  │
│          ├─ Agent: claude-rescue ──▶ claude -p ⇢ GLM-5      │
│          ├─ Agent: claude-rescue ──▶ claude -p ⇢ DeepSeek   │
│          └─ Agent: claude-rescue ──▶ claude -p ⇢ Qwen3.6    │
└─────────────────────────────────────────────────────────────┘
```

## What it solves

**"Can I have a single Claude Code conversation where Claude Code can use multiple models, including non-official ones?"** — yes. That's the whole product.

Built-in Claude Code subagents share the parent's auth and are locked to official Anthropic models. Proxy-style routers (`claude-code-router`, `cc-switch`) solve "switch the whole session to one alt backend" — useful, but different problem: your main thread is no longer native Claude once a proxy is in front. `claude-rescue` keeps the main thread untouched and gives you **per-dispatch** backend selection:

- **Save subscription quota** — offload long jobs to pay-as-you-go or cheap third-party providers, main thread keeps its plan warm.
- **Right model per task** — GLM-5 for long-context, DeepSeek-v4-pro for deep reasoning, Qwen3.6-Plus for vision, Sonnet for polish.
- **Isolation** — each dispatch is a fresh `claude` subprocess with its own env, CWD, and job dir. Fail one, the others keep running.
- **No proxy in front of your main thread.** You're still talking to real Claude.

Architecturally mirrors the `codex-rescue` / `opencode-rescue` pattern (thin forwarder subagent + companion runtime), but the spawned CLI is `claude` itself talking to a rotated backend.

## Quick start

### 1. Install as a local Claude Code plugin

```bash
git clone https://github.com/<you>/claude-rescue ~/project/claude-rescue
ln -s ~/project/claude-rescue ~/.claude/plugins/local/claude-rescue
```

Or install the subagent directly:

```bash
# Point CLAUDE_PLUGIN_ROOT manually in agents/claude-rescue.md, then:
ln -s ~/project/claude-rescue/agents/claude-rescue.md ~/.claude/agents/claude-rescue.md
```

### 2. Configure sources

```bash
cp scripts/sources.example.json scripts/sources.json
$EDITOR scripts/sources.json
```

Each source is an (env + model) combo pointing at any **Anthropic-compatible** endpoint:

```jsonc
{
  "default": "my-payg",
  "sources": {
    "my-payg": {
      "env": { "ANTHROPIC_API_KEY": "@secret:ANTHROPIC_PAYG" },
      "model": "claude-sonnet-4-6"
    },
    "deepseek-pro": {
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "@secret:DEEPSEEK_KEY"
      },
      "model": "deepseek-v4-pro"
    }
  }
}
```

### 3. Provide env vars

`${VAR}` placeholders are resolved from the companion's own `process.env` at invocation time. **claude-rescue does not read any secret store directly** — pick whatever workflow you prefer:

```bash
# plain shell
export ANTHROPIC_API_KEY=sk-ant-...
export DEEPSEEK_KEY=sk-...
claude                                      # all downstream dispatches inherit these

# direnv / .envrc
echo 'export DEEPSEEK_KEY=sk-...' >> ~/project/my-repo/.envrc && direnv allow

# 1Password CLI
op run --env-file=.env.1p -- claude

# pass / bitwarden / vault / age — wrap however you like
```

If a required env var is missing, the companion fails with a clear `Env var "X" is not set` message instead of silently hitting a 401.

### 4. Dispatch

From the main Claude Code thread:

```
Agent(subagent_type="claude-rescue", prompt="refactor this module source=deepseek-pro")
```

Or directly:

```bash
node scripts/claude-companion.mjs task "refactor this module" --source deepseek-pro
node scripts/claude-companion.mjs task "long job"             --source deepseek-pro --background
node scripts/claude-companion.mjs list-sources
node scripts/claude-companion.mjs status <job-id>
node scripts/claude-companion.mjs result <job-id>
```

## Known-good backends

Any Anthropic-compatible endpoint works. Tested:

| Provider | `ANTHROPIC_BASE_URL` | Example models |
|---|---|---|
| Anthropic (official) | _(unset)_ | `claude-sonnet-4-6`, `claude-opus-4-7` |
| DeepSeek | `https://api.deepseek.com/anthropic` | `deepseek-v4-pro`, `deepseek-v4-flash` |
| Aliyun Model Studio CodingPlan | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | `qwen3.6-plus`, `glm-5`, `glm-4.7`, `kimi-k2.5`, `MiniMax-M2.5` |
| Zhipu BigModel | `https://open.bigmodel.cn/api/anthropic` | `glm-4.7`, `glm-4.5-flash` |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | `http://localhost:3456` | any (router maps to OpenAI/Gemini/etc.) |

## How it works

```
main Claude Code (your subscription)
        │
        ▼  Agent(subagent_type="claude-rescue", prompt="... source=X")
┌──────────────────┐
│ claude-rescue.md │  thin forwarder (ships with this repo)
└────────┬─────────┘
         │  Bash: node claude-companion.mjs task ...
         ▼
┌──────────────────┐
│ claude-companion │  loads source from sources.json
│ (Node.js, ~400 LOC) │  resolves @secret: from ~/.claude/secrets.json
│                  │  strips ANTHROPIC_* from env
└────────┬─────────┘  spawns fresh claude with chosen env + model
         ▼
┌──────────────────┐
│ claude -p        │  ← talks to YOUR chosen backend, not subscription
│ --model X --...  │
└──────────────────┘
```

## Status

MVP. Works end-to-end. Intentionally minimal — no hooks, no slash commands, no review/adversarial modes. See [GAPS.md](GAPS.md) for what's missing vs the reference codex/opencode rescue plugins.

## License

MIT
