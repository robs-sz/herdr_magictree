/**
 * `down` action: stop this worktree's stack.
 *
 * The counterpart of `up`, and the piece that makes deleting a worktree safe:
 * Herdr removes the checkout with `git worktree remove --force`, which fails
 * with "Directory not empty" when the stack is still writing into it, and the
 * plugin's own gc only learns about a removal *after* that deletion — too late
 * to stop anything. Stopping on demand closes that gap.
 *
 * Every outcome is reported through a notification and the plugin log, and the
 * action always exits 0, mirroring `action-up.ts`.
 */
import { basename } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { capLine, log } from "./log.ts";
import { downCommand, onboarded, renderCommand, resolveBin } from "./magictree.ts";
import { missingBinReason, notify } from "./start.ts";
import { readState, runKey, updateRecord } from "./state.ts";
import { resolveWorktreePath } from "./worktree-path.ts";

async function main(): Promise<void> {
  const resolved = resolveWorktreePath();
  if (resolved === null) {
    const workspaceId = process.env.HERDR_WORKSPACE_ID ?? "unknown";
    log("down", `no worktree for workspace ${workspaceId}`);
    notify(null, "No worktree here", "this workspace is not a Git worktree");
    process.exit(0);
  }
  const path = resolved.path;
  const key = runKey(path);
  const label = basename(path);

  let cfg: Config;
  try {
    cfg = loadConfig().config;
  } catch (error) {
    const reason = (error as Error).message;
    log("down", reason);
    notify(null, "Bad config", reason);
    process.exit(0);
  }

  if (resolveBin(cfg) === null) {
    notify(cfg, "Magictree not found", missingBinReason(cfg.magictreeBin));
    process.exit(0);
  }

  if (!onboarded(path)) {
    log("down", `no magictree.toml for ${path}`);
    notify(cfg, "Not onboarded", "magictree not initialized — run magictree discover, then magictree init");
    process.exit(0);
  }

  log("down", `running ${renderCommand(downCommand(cfg, path))}`);
  const proc = Bun.spawnSync(downCommand(cfg, path), {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
    timeout: cfg.upTimeoutSecs * 1000,
  });
  const output = `${proc.stderr.toString()}${proc.stdout.toString()}`.trim();
  const detail = capLine(output) || `exit ${proc.exitCode ?? "-"}`;

  // Bun leaves `signalCode` undefined (not null) on a clean exit, so the
  // success flag — not a null check — is the honest "exited cleanly" test.
  if (!proc.success) {
    notify(cfg, "Stop failed", `${label} — ${detail}`);
    log("down", `failed ${path}: ${detail}`);
    process.exit(0);
  }

  // Only a run this plugin started has a record to settle; `down` on a stack
  // we never started must not invent history.
  if (readState().worktrees[key] !== undefined) {
    updateRecord(key, {
      status: "stopped",
      services: [],
      finished_at_ms: Date.now(),
      pid: null,
      error: null,
    });
  }
  notify(cfg, "Stack stopped", label);
  log("down", `stopped ${path}: ${detail}`);
  process.exit(0);
}

void main();
