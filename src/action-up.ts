/**
 * `up` action: start (or ensure) this worktree's stack on demand.
 *
 * All run outcomes — started, failed, no manifest, missing binary — are already
 * reported by `src/start.ts` and `src/up.ts`, which are the single notification
 * sites for those. The only thing this wrapper adds is the `skipped` case,
 * because "nothing to do" has no other voice.
 */
import { log } from "./log.ts";
import { notify, startStackRun } from "./start.ts";
import { contextJson, resolveWorktreePath } from "./worktree-path.ts";

async function main(): Promise<void> {
  const resolved = resolveWorktreePath();
  if (resolved === null) {
    const workspaceId = process.env.HERDR_WORKSPACE_ID ?? "unknown";
    log("action", `no worktree for workspace ${workspaceId}`);
    notify(null, "magictree: no worktree here", `workspace ${workspaceId} is not a Git worktree`);
    process.exit(0);
  }

  const ctx = contextJson();
  const workspaceId =
    (typeof ctx.workspace_id === "string" ? ctx.workspace_id : null) ??
    process.env.HERDR_WORKSPACE_ID ??
    null;

  log("action", `up ${resolved.path} (via ${resolved.source})`);
  const outcome = await startStackRun({
    path: resolved.path,
    branch: null,
    label: null,
    workspaceId,
    source: resolved.source,
    trigger: "action",
  });

  if (outcome.kind === "skipped") {
    notify(null, "magictree: nothing to do", outcome.reason);
  }
  log("action", JSON.stringify(outcome));
  process.exit(0);
}

void main();
