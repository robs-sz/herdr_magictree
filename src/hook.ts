/**
 * `worktree.created` hook.
 *
 * Runs with Herdr's event JSON in the environment and must never fail: a
 * non-zero exit would be noise in `herdr plugin log list` for something the user
 * cannot act on. Every path therefore exits 0 and reports through a
 * notification and the plugin log.
 *
 * The raw event is persisted before anything is parsed, so the payload shape is
 * always observable from `state/last-event.json` even when the parse rejects it.
 */
import { existsSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { lastEventPath } from "./paths.ts";
import { notify, startStackRun } from "./start.ts";
import { collectWorktree } from "./teardown.ts";
import { parseWorktreeEvent, snapshotWorktreePath } from "./worktree-path.ts";

const RAW_PREFIX = 200;

async function main(): Promise<void> {
  const eventJson = process.env.HERDR_PLUGIN_EVENT_JSON ?? null;
  try {
    writeFileSync(
      lastEventPath(),
      `${JSON.stringify(
        {
          received_at: new Date().toISOString(),
          plugin_event: process.env.HERDR_PLUGIN_EVENT ?? null,
          event_json: eventJson,
          context_json: process.env.HERDR_PLUGIN_CONTEXT_JSON ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    log("hook", `could not persist ${lastEventPath()}: ${(error as Error).message}`);
  }

  let cfg;
  try {
    cfg = loadConfig().config;
  } catch (error) {
    const reason = (error as Error).message;
    log("hook", reason);
    notify(null, "Bad config", reason);
    process.exit(0);
  }

  if (!cfg.enabled) {
    log("hook", "disabled");
    process.exit(0);
  }

  const event = parseWorktreeEvent(eventJson ?? undefined);
  if (event === null) {
    log("hook", `ignored event: ${(eventJson ?? "<unset>").slice(0, RAW_PREFIX)}`);
    process.exit(0);
  }

  if (event.kind === "removed") {
    if (!cfg.onWorktreeRemoved) {
      log("hook", `worktree removal hook disabled; leaving ${event.path} alone`);
      process.exit(0);
    }
    log("hook", `remove ${event.path} (workspace ${event.workspaceId ?? "-"})`);
    const teardown = collectWorktree({
      path: event.path,
      label: event.label,
      branch: event.branch,
      workspaceId: event.workspaceId,
      repoRoot: event.repoRoot,
    });
    log("hook", JSON.stringify(teardown));
    process.exit(0);
  }

  if (!cfg.onWorktreeCreated) {
    log("hook", `worktree creation hook disabled; ignoring ${event.path}`);
    process.exit(0);
  }

  let { path } = event;
  if (!existsSync(path) && event.workspaceId !== null) {
    const fromSnapshot = snapshotWorktreePath(event.workspaceId);
    if (fromSnapshot !== null) {
      log("hook", `event path ${path} is missing; using snapshot path ${fromSnapshot}`);
      path = fromSnapshot;
    }
  }
  if (!existsSync(path)) {
    log("hook", `no usable checkout for ${path} (workspace ${event.workspaceId ?? "-"}); nothing to do`);
    process.exit(0);
  }

  log("hook", `start ${path} (workspace ${event.workspaceId ?? "-"})`);
  const outcome = await startStackRun({
    path,
    branch: event.branch,
    label: event.label,
    workspaceId: event.workspaceId,
    source: "event",
    trigger: "hook",
  });
  log("hook", JSON.stringify(outcome));
  process.exit(0);
}

void main();
