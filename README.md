# claude-rescue

A Claude Code subagent that delegates tasks to an **independent `claude` CLI subprocess** with a user-chosen Anthropic-compatible backend — swap model, key, or endpoint per task without touching your main-thread subscription.

## Why

Claude Code's built-in subagents share the parent's authentication and are locked to official Anthropic models. `claude-rescue` breaks that:

- **Save subscription quota** — run long jobs on pay-as-you-go or a third-party provider while your main thread keeps its Pro/Max plan warm.
- **Pick the right model per task** — GLM-5 for long-context, DeepSeek-v4-pro for deep reasoning, Qwen3.6-Plus for vision, Sonnet for polish.
- **Isolation** — each dispatch is a fresh `claude` process with its own env, own CWD, own job dir.

Architecturally mirrors the `codex-rescue` / `opencode-rescue` pattern (thin forwarder agent + companion runtime), but the subprocess is `claude` itself talking to a different backend.

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

### 3. Add secrets

`@secret:NAME` placeholders are resolved from `~/.claude/secrets.json`:

```json
{
  "ANTHROPIC_PAYG":  { "value": "sk-ant-...",    "description": "Anthropic pay-as-you-go" },
  "DEEPSEEK_KEY":    { "value": "sk-...",        "description": "DeepSeek API" }
}
```

Keep `secrets.json` at `chmod 600`. The companion only reads the specific key it needs, never logs values.

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
