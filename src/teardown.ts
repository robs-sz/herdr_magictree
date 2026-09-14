/**
 * Lifecycle teardown for `worktree.removed`.
 *
 * Herdr deletes the checkout *before* it fires the event — verified: the hook
 * sees `path_exists: false`. That rules out `magictree down`, which stops host
 * services by reading pid files from `<checkout>/.magictree`, and it rules out
 * `down --volumes` for the same reason. What remains is `magictree gc`, which is
 * built for exactly this: reconcile a repository against its live checkouts,
 * release the port blocks of the ones that are gone, and remove the compose
 * containers *and volumes* labelled for them.
 *
 * `gc` is per-repository, so it needs the repository root rather than the dead
 * checkout. The event carries it; the plugin's own record is the fallback.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { ConfigError, loadConfig, type Config, type LoadedConfig } from "./config.ts";
import { log } from "./log.ts";
import { gcCommand, renderCommand, resolveBin } from "./magictree.ts";
import { missingBinReason, notify } from "./start.ts";
import { deleteRecord, readState, runKey, updateRecord } from "./state.ts";

export type TeardownRequest = {
  path: string;
  label: string | null;
  branch: string | null;
  workspaceId: string | null;
  repoRoot: string | null;
};

export type TeardownOutcome =
  | { kind: "reclaimed"; key: string; repoRoot: string; lines: string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; key: string; reason: string };

const SUMMARY_LINES = 3;
const ERROR_CAP = 120;

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.length > ERROR_CAP ? `${trimmed.slice(0, ERROR_CAP - 3)}...` : trimmed;
  }
  return null;
}

export function collectWorktree(req: TeardownRequest): TeardownOutcome {
  const key = runKey(req.path);

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig();
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : `cannot load config: ${(error as Error).message}`;
    log("teardown", reason);
    notify(null, "Bad config", reason);
    return { kind: "failed", key, reason };
  }
  const cfg: Config = loaded.config;

  if (!cfg.enabled || !cfg.onWorktreeRemoved) {
    log("teardown", `disabled; leaving ${req.path} to the user`);
    return { kind: "skipped", reason: "plugin disabled" };
  }

  // No record means this plugin never started anything here, which is the case
  // for every worktree of every repository without a magictree manifest. Calling
  // gc then would spend two `docker` round trips to learn nothing.
  const record = readState().worktrees[key];
  if (!record) {
    log("teardown", `no record for ${req.path}; nothing to reclaim`);
    return { kind: "skipped", reason: "no record" };
  }

  if (resolveBin(cfg) === null) {
    const reason = missingBinReason(cfg.magictreeBin);
    notify(cfg, "Magictree not found", reason);
    return { kind: "failed", key, reason };
  }

  const repoRoot = req.repoRoot ?? record.repo_root;
  if (repoRoot === null) {
    log("teardown", `no repository root for ${req.path}; port block not reclaimed`);
    return { kind: "skipped", reason: "no repository root" };
  }
  if (!existsSync(repoRoot)) {
    log("teardown", `repository ${repoRoot} is gone; nothing to reclaim`);
    return { kind: "skipped", reason: `repository gone: ${repoRoot}` };
  }

  const argv = gcCommand(cfg, repoRoot);
  const proc = Bun.spawnSync(argv, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const lines = proc.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) log("teardown", line);

  if (proc.exitCode !== 0) {
    const reason = firstLine(proc.stderr.toString()) ?? `magictree gc exited with code ${proc.exitCode}`;
    updateRecord(key, { status: "failed", finished_at_ms: Date.now(), pid: null, error: reason });
    notify(cfg, "Cleanup failed", `${req.label ?? basename(req.path)} — ${reason}`);
    log("teardown", `failed ${req.path}: ${reason}`);
    return { kind: "failed", key, reason };
  }

  // The checkout is gone, so the record describes nothing that exists any more.
  // The run log is left on disk as the transcript.
  deleteRecord(key);
  const label = req.label ?? req.branch ?? basename(req.path);
  const summary = lines.length > 0 ? lines.slice(0, SUMMARY_LINES).join("; ") : "nothing to reclaim";
  notify(
    cfg,
    "Worktree cleaned up",
    `${label} — ${lines.length > 0 ? "ports and containers released" : "nothing to reclaim"}`,
  );
  log("teardown", `collected ${req.path} via ${renderCommand(argv)} (${summary})`);
  return { kind: "reclaimed", key, repoRoot, lines };
}
