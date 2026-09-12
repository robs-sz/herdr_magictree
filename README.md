# Herdr magictree plugin

Starts a worktree's magictree development stack when Herdr
creates the worktree, and reports the outcome as a Herdr notification.

`herdr worktree create` gives you a checkout with no services running. This plugin
hooks `worktree.created`, runs `magictree up` for the new checkout in the background
(so the Herdr event is never blocked by a bootstrap), records the result per worktree,
and toasts `stack ready` / `stack failed` / `repository not onboarded`. Two manual
actions follow: re-run the stack for the current worktree, and open a popup showing the
recorded state, the live `magictree status`, and the run log.

It also hooks `worktree.removed` and runs `magictree gc` for the repository, which
releases the removed worktree's port block and removes the compose containers and
volumes of its project. See [Cleanup on removal](#cleanup-on-removal) for what that
does and does not reach.

## Requirements

- `herdr` 0.9.0 or newer
- `magictree` on `PATH` (or set `magictree_bin`)
- `bun` on `PATH`

## Install

```sh
cd /path/to/herdr_magictree
bun install          # required: `herdr plugin link` does not run [[build]]
herdr plugin link .
herdr plugin list    # magictree (Magictree Stacks) enabled
```

## Configuration

Created on first use at the path printed by `herdr plugin config-dir magictree`
(usually `~/.config/herdr/plugins/config/magictree/config.toml`). It is re-read on
every hook, action, and popup invocation, so edits need no restart.

```toml
# Herdr plugin "magictree" — https://github.com/<owner>/herdr_magictree
# Restart-free: read on every hook, action, and popup invocation.

# Master switch for the automatic hook. Manual actions still work when false.
enabled = true

# Run when Herdr creates a new worktree.
on_worktree_created = true

# Run "magictree gc" when Herdr removes a worktree: releases its port block and
# removes the compose containers, volumes, and host processes recorded for it.
# Herdr deletes the checkout before the event fires, so "magictree down" cannot
# run at that point; gc works from magictree's own state dir instead.
on_worktree_removed = true

# Behavior when the worktree's repository has no magictree.toml:
#   "notify" - record the worktree and report the commands to run (default)
#   "skip"   - record nothing about it
missing_manifest = "notify"

# Extra argv appended to `magictree up`, e.g. ["--app", "web"] or ["--all"].
args = []

# Kill a run that exceeds this many seconds.
up_timeout_secs = 1800

# Show a Herdr notification when a run starts, succeeds, or fails.
notify = true

# magictree executable. Absolute path or a name resolved on PATH.
magictree_bin = "magictree"
```

An unrecognised key is ignored with a warning (visible in `plugin.log` and in the
popup) rather than failing the load; an invalid value, such as
`missing_manifest = "nope"`, reports a notification naming the key and its allowed
values.

## Actions

- **Magictree: start this worktree's stack** (`up`) — runs `magictree up` for the
  current workspace's worktree and reports the outcome. Idempotent: magictree reuses
  the worktree's existing port assignment and leaves a healthy service running.
- **Magictree: show stack status** (`stack`) — opens the popup described below.

Without a keybinding:

```sh
herdr plugin action invoke up --plugin magictree
herdr plugin pane open --plugin magictree --entrypoint stack --placement popup
```

Suggested binding, added by you to `~/.config/herdr/config.toml`
(the plugin does not modify your config):

```toml
[[keys.command]]
key = "prefix+shift+m"
type = "plugin_action"
command = "magictree.up"
description = "magictree: start stack"
```

The popup shows the worktree path and how it was resolved, the recorded run state
(status, pid, start/finish), the parsed service URLs, the config path and its warning
count, the exact command that was run, the live `magictree status` output, and the last
15 lines of the run log. It also renders without a TTY, which makes it scriptable:

```sh
HERDR_PLUGIN_STATE_DIR=~/.local/state/herdr/plugins/magictree \
HERDR_PLUGIN_CONFIG_DIR=~/.config/herdr/plugins/config/magictree \
HERDR_WORKSPACE_ID=<workspace id> \
  bun run src/stack-pane.ts --print
```

## Cleanup on removal

When Herdr removes a worktree it fires `worktree.removed` **after deleting the
checkout** — verified against the live event, which reports the path as already gone.
That rules out `magictree down`: magictree stops host services from pid files it keeps for
the worktree and resolves the manifest from the checkout, so with the directory removed it
can only fail. `down --volumes` fails for the same reason.

What the hook runs instead is `magictree gc --cwd <repository root>`, which works from
magictree's own state dir and reclaims everything the removed worktree left behind:

- **host processes** started from the checkout, stopped by the pid files magictree keeps
  in `~/.local/state/magictree/worktrees/<repo>/<worktree>/run/`,
- **compose containers and their named volumes**, found through the worktree's compose
  project, so `--volumes` semantics are preserved for compose services,
- the **port block** assigned to it.

All three are scoped to the repository, so other repositories — and live worktrees of this
one — are never touched. The plugin then forgets its state record for that worktree and
leaves the run log in place as the transcript. Nothing is run, and no toast is shown, for a
worktree this plugin never started anything for, so removals in repositories without a
`magictree.toml` cost nothing.

This needs a magictree build that keeps runtime state outside the checkout. An older build
keeps pid files inside `<worktree>/.magictree`, where they are deleted along with the
checkout; against such a build the hook still reclaims port blocks and compose resources,
and host processes survive it. `grep teardown ~/.local/state/herdr/plugins/magictree/plugin.log`
shows which of the three each removal actually reclaimed.

Set `on_worktree_removed = false` to leave every removal to you.

## State and logs

Under `~/.local/state/herdr/plugins/magictree`:

- `state.json` — one record per worktree: key, path, branch, workspace id, the
  repository root, status
  (`running` / `ready` / `failed` / `no_manifest` / `skipped`), timings, log path,
  the command that ran, the error, and the parsed services. A worktree removed through
  Herdr is forgotten here once its cleanup succeeds; one removed behind Herdr's back
  stays, and the popup marks it `gone`.
- `logs/<key>.log` — the full `magictree up` transcript for that worktree, including
  bootstrap output, written by the detached runner.
- `plugin.log` — every hook, action, and runner line, with timestamps. This is the
  first place to look when the automatic hook did nothing.
- `last-event.json` — the raw event and invocation context of the last
  `worktree.created` hook, written before any parsing.

Herdr also keeps its own per-invocation transcript of plugin commands:

```sh
herdr plugin log list --plugin magictree --limit 10
```

## Troubleshooting

- **The hook did nothing.** `cat ~/.local/state/herdr/plugins/magictree/last-event.json`
  shows whether Herdr delivered the event at all and which payload it carried. If the
  file is stale, the event did not fire.
- **The worktree was created but the stack failed.** Read `logs/<key>.log` for the
  magictree output, then re-check the manifest from the checkout:
  `magictree doctor --cwd <worktree>`.
- **Services look down.** `magictree status --probe --cwd <worktree>` runs the health
  probes, `magictree logs <service> --cwd <worktree>` follows one service's output, and
  `magictree down --cwd <worktree>` stops the stack.
- **The repository is not onboarded.** The plugin reports the three commands to run:
  `magictree discover`, `magictree init`, then re-run the `up` action.
- **A dev server is still running after a worktree was removed.** Check
  `grep teardown ~/.local/state/herdr/plugins/magictree/plugin.log`: if the removal reports
  no `stopping <service> (pid …)`, the worktree's stack was not recorded here, or magictree
  predates the state layout described in [Cleanup on removal](#cleanup-on-removal).
- **Cleanup did nothing.** The same log line shows the `gc` command and its output for
  every removal, including the ones it deliberately skipped.

## Roadmap

A richer TUI — following the run log, running the health probe, `docker compose
-p <slug> exec` into compose services, and opening a service URL in a new Herdr tab or
pane — consumes the same `state.json` records and the same entrypoint,
`src/stack-pane.ts`.
