---
description: Dispatch a task to an independent claude subprocess with a configurable backend
argument-hint: <task> [source=name] [model=name] [background]
---

Dispatch the user's task through the claude-rescue subagent. Forward the user's prompt
verbatim to `Agent(subagent_type="claude-rescue", prompt="{{args}}")`. Extract `source=`,
`model=`, `background` hints from args if present; pass them along.

Note: The agent now waits for job completion even when backgrounding is used. The
`background` flag is a power-user knob for fire-and-forget via direct CLI; when using
the subagent, the main thread receives completion info regardless.