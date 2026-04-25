---
description: Dispatch a task to an independent claude subprocess with a configurable backend
argument-hint: <task> [source=name] [model=name] [background]
---

Dispatch the user's task through the claude-rescue subagent. Forward the user's prompt
verbatim to `Agent(subagent_type="claude-rescue", prompt="{{args}}")`. Extract `source=`,
`model=`, `background` hints from args if present; pass them along.