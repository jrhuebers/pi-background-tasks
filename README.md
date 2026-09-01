# pi-background-tasks

A minimal Pi extension for managed local background processes. It provides an
overridden `bash` tool, a `jobs` tool, and an operator-facing `/jobs` command.

## Configuration

`config.yaml` is read from the extension directory:

```yaml
background_after_seconds: 30
```

This is the default foreground delay. A `bash` call can override it.

## Tools

```ts
bash({
  command: string,
  description?: string,
  run_in_background?: boolean,       // default false
  background_after_seconds?: number, // default from config.yaml
  max_run_seconds?: number,          // unlimited if omitted
  notify_on_exit?: boolean,          // default true
})

jobs({
  action?: "list" | "kill" | "extend", // default list
  job_id?: string,                         // required for kill and extend
  max_run_seconds?: number,                // required for extend
})
```

Job IDs are session-local (`job-1`, `job-2`, …). `extend` sets a new total
runtime limit measured from process creation; it must exceed the current finite
limit. Jobs run in their own process group, so `kill` terminates the group.

Logs are written below `.pi-background-tasks/<session-token>/` in the current
project. The extension persists active job state in the Pi session. On an
explicit Pi quit it sends `SIGTERM` to all managed process groups; on reload it
restores monitoring of still-running groups.

## TUI

The Pi TUI shows the number of running managed jobs in light-grey text, right-aligned on the footer line beside the path.

## Optional integrations

The extension itself has no tmux dependency. It emits these event-bus events:

- `background-tasks:started` — `{ id, description, logPath, pid, pgid }`
- `background-tasks:finished` — `{ id, description, logPath, status, exitCode }`

A host package can subscribe to create log viewers or other UI.
