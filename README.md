# Herdr magictree plugin

Starts a worktree's magictree development stack when Herdr creates the worktree, and
reclaims it when Herdr removes one.

## Requirements

- `herdr` 0.9.0 or newer
- `magictree` on `PATH` — `herdr plugin install` runs this as a build step and refuses to
  register the plugin without it (`magictree_bin` overrides the binary at runtime only)
- `bun` on `PATH`

## Install

```sh
cd /path/to/herdr_magictree
bun install          # required: `herdr plugin link` does not run [[build]]
herdr plugin link .
```

`herdr plugin install` runs both `[[build]]` steps itself: `bun install`, then the check
that `magictree` is on `PATH`.

## What it does

| Herdr event | the plugin |
|---|---|
| `worktree.created` | runs `magictree up` in the background, with a sidebar badge and toasts until the stack is up |
| `worktree.removed` | runs `magictree gc` for the repository: releases the worktree's port block and removes its compose containers, volumes and host processes |

A repository with no `magictree.toml` is reported as needing onboarding — the toasts show
the commands to run — rather than started, unless `missing_manifest = "skip"`.

While a run is live, the plugin reports a `working` state label on the run's workspace
pane — `up <label> 2m10s — <last log line>` — which Herdr's sidebar keeps showing while
the keyboard stays with your pane. The label is display-only metadata: it never takes
input, never blocks a modal, and the runner clears it on every exit path, so a settled or
failed run can never leave a stale `working` badge behind. Alongside it the same toasts
as before appear: `Starting stack` (when no badge could be reported), then
`Stack still starting` at 1m and every 5m after that, because a Herdr toast is visible
for three seconds.

## Configuration

`~/.config/herdr/plugins/config/magictree/config.toml`
(`herdr plugin config-dir magictree`). It is written on first use with a comment per key —
`enabled`, `on_worktree_created`, `on_worktree_removed`, `missing_manifest`, `args`,
`up_timeout_secs`, `notify`, `magictree_bin` — and re-read on every invocation, so edits
need no restart.

## Actions

- **Magictree: start this worktree's stack** (`up`) — starts or ensures the stack for the
  current worktree. Idempotent: it keeps the ports the worktree already has. Shows the same
  sidebar badge as the automatic hook.
- **Magictree: stop this worktree's stack** (`down`) — runs `magictree down` for the current
  worktree. Run this **before deleting a worktree**: Herdr removes the checkout with
  `git worktree remove --force`, which fails with `Directory not empty` while the stack is
  still writing into it, and this plugin's cleanup only learns about a removal after that
  deletion.
- **Magictree: show stack status** (`stack`) — a popup with the recorded state, the live
  `magictree status`, and the tail of the run log. Renders without a TTY under `--print`.

```sh
herdr plugin action invoke up --plugin magictree
```

Bind it yourself in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+m"
type = "plugin_action"
command = "magictree.up"
description = "magictree: start stack"
```

## State and logs

`~/.local/state/herdr/plugins/magictree/`:

- `state.json` — one record per worktree
- `logs/<worktree>.log` — the full `magictree up` transcript
- `plugin.log` — every hook, action and runner line
- `last-event.json` — the last `worktree.created` payload

`herdr plugin log list --plugin magictree` shows Herdr's own transcript of the same runs.

## Troubleshooting

- **The hook did nothing.** `last-event.json` shows whether Herdr delivered an event at all.
- **A run failed.** `logs/<worktree>.log` has magictree's output; in the checkout,
  `magictree doctor` reports drift and `magictree down` stops the stack.
- **Removal reclaimed nothing.** `grep teardown plugin.log` shows the `gc` command and its
  output for every removal, including the ones it skipped.

## Roadmap

A richer TUI — log follow, health probe, `docker compose -p <slug> exec`, opening a service
URL in a new tab — grows from the same `state.json` and the same entrypoint,
`src/stack-pane.ts`.
