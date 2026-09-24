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
| `worktree.created` | runs `magictree up` in the background and opens an unfocused progress pane below the worktree's existing pane |
| `worktree.removed` | runs `magictree gc` for the repository: releases the worktree's port block and removes its compose containers, volumes and host processes |

A repository with no `magictree.toml` is reported as needing onboarding — the toasts show
the commands to run — rather than started, unless `missing_manifest = "skip"`.

While a run is live, an unfocused split pane opens at the bottom of the new
workspace and resizes to Herdr's minimum pane height. It keeps a spinner,
elapsed time, and the latest non-empty line from the run log visible until the
stack reaches a terminal state. If Herdr cannot open the pane, notifications
provide the fallback progress signal.
Herdr still draws the outer border using its unfocused-pane style; plugin panes
expose no per-pane active-border override.

## Configuration

`~/.config/herdr/plugins/config/magictree/config.toml`
(`herdr plugin config-dir magictree`). It is written on first use with a comment per key —
`enabled`, `on_worktree_created`, `on_worktree_removed`, `missing_manifest`, `args`,
`up_timeout_secs`, `notify`, `magictree_bin` — and re-read on every invocation, so edits
need no restart.

## Actions

- **Magictree: start this worktree's stack** (`up`) — starts or ensures the stack for the
  current worktree. Idempotent: it keeps the ports the worktree already has. Shows the same
  bottom progress pane as the automatic hook.
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
