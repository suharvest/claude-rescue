# Contributing

Thanks for taking an interest. claude-rescue is small (~450 LOC), pragmatic, and intentionally minimal — contributions that match that spirit land fastest.

## Before you open a PR

- **Issues welcome** — bug reports, feature requests, "does this work with X backend?" — open one first if the change is non-trivial, so we can align on scope.
- **Node built-ins only.** The runtime has zero dependencies by design; PRs adding npm packages will be declined unless there's no reasonable alternative.
- **Keep the MVP posture.** See [GAPS.md](GAPS.md) for the prioritized roadmap. Features outside the P0/P1 list are a harder sell — please open an issue first.
- **One concern per PR.** Bug fix, new source, or docs — not all three.

## Dev workflow

```bash
git clone https://github.com/suharvest/claude-rescue
cd claude-rescue

# configure a source
cp scripts/sources.example.json scripts/sources.json
export ANTHROPIC_API_KEY=sk-ant-...       # or whatever your sources.json references

# smoke test
node scripts/claude-companion.mjs list-sources
node scripts/claude-companion.mjs task "say OK in one word" --source anthropic-payg
```

No test suite yet (see GAPS.md). If you add a feature, please include a minimal reproducible smoke-test command in the PR description.

## Adding a backend to "Known-good"

Propose a new row in the README provider table only after you've confirmed end-to-end:

1. `list-sources` shows it.
2. A trivial prompt (`"say HELLO"`) returns non-error through the stream.
3. The token is not logged anywhere in `jobs/<id>/`.

Paste the verification transcript in the PR.

## Style

- **ESM (`.mjs`)**, Node 18+ syntax.
- No classes unless they earn their keep. Functions first.
- Comments explain *why*, not *what*. Remove a comment before adding it if the code could be clarified instead.
- No emoji in code or commit messages. README is the only place they earn a spot.

## Commit messages

Short subject (~70 chars), optional body with *why*. Conventional-commits is welcome but not required.

Good:

```
Cap recursive nesting at depth 3 via CLAUDE_RESCUE_DEPTH env var

Each spawn increments CLAUDE_RESCUE_DEPTH in child env. Companion
refuses to spawn when depth >= CLAUDE_RESCUE_MAX_DEPTH. Prevents
runaway cost if a child prompt accidentally redispatches.
```

## License

By contributing, you agree your work is released under the [MIT License](LICENSE).
