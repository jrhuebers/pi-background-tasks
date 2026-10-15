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

Logs are written below Node's `os.tmpdir()/pi-background-tasks-<uid>/<session-token>/`, outside the current project, so users on shared hosts do not collide. On Linux this is typically `/tmp`; on macOS it honors the system temporary-directory location (usually under `/var/folders`).

Every Bash invocation atomically reserves a private `invocation-<unique-suffix>/`
directory containing `output.log` and `exit.status`. This happens before process
creation and is independent of the session-local background-job counter, so
concurrent foreground calls cannot share or delete each other's files. Promotion
to a background job retains the invocation's original paths. Completed foreground
calls remove their files and invocation directory; background logs are retained.
Failed process initialization also cleans up its reserved invocation storage.
Directories and files are created with owner-only permissions and may be removed
by the operating system as temporary data.

The session token is a 12-character SHA-256 prefix of the session-file path. For
sessions without a session file, it is derived from a fresh random UUID instead
of the process ID. Persisted state retains its token and exact job paths across
reloads, including paths saved by older versions.
The extension persists active job state in the Pi session. On an explicit Pi
quit it sends `SIGTERM` to all managed process groups; on reload it restores
monitoring of still-running groups.

## TUI

The Pi TUI shows the number of running managed jobs in light-grey text, right-aligned on the footer line beside the path.

## Optional integrations

The extension itself has no tmux dependency. It emits these event-bus events:

- `background-tasks:started` — `{ id, description, logPath, pid, pgid }`
- `background-tasks:finished` — `{ id, description, logPath, status, exitCode }`

A host package can subscribe to create log viewers or other UI.

## Regression tests

With Node.js 22+ and an installed Pi package:

```sh
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

`PI_PACKAGE_DIR` can be omitted when that package is resolvable from the checkout.
Tests load the actual extension with Pi's TypeScript loader and host-provided
peers, using isolated temporary sessions and short-lived local subprocesses. They
do not start a model or modify live sessions. Coverage includes concurrent
foreground output, failure cleanup, immediate background jobs, automatic
promotion, session isolation, restoration of persisted session identity and active
legacy job paths, and safe cleanup after process-launch failure. Test subprocesses
have bounded lifetimes.
