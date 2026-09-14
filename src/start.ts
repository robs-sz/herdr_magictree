/**
 * Shared preflight for the automatic hook and the manual action, plus the
 * detached launch of `src/up.ts`.
 *
 * The split exists so a slow `magictree up` (bootstrap, installs, health waits)
 * never blocks the Herdr event that triggered it: this module decides *whether*
 * to run and hands the actual work to a detached process. It is also the single
 * place that emits run notifications, which keeps hook and action from
 * double-toasting the same outcome.
 */
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { ConfigError, loadConfig, type Config, type LoadedConfig } from "./config.ts";
import { log } from "./log.ts";
import {
  isWorktreeReady,
  manifestPath,
  renderCommand,
  repoRoot,
  repositoryRoot,
  resolveBin,
  upCommand,
} from "./magictree.ts";
import { herdrBin, logPath, pluginRoot } from "./paths.ts";
import { acquireRunLock, releaseRunLock, runKey, updateRecord } from "./state.ts";

export type StartRequest = {
  path: string;
  branch: string | null;
  label: string | null;
  workspaceId: string | null;
  source: string;
  trigger: "hook" | "action";
};

export type StartOutcome =
  | { kind: "started"; key: string; pid: number | null; logPath: string }
  | { kind: "skipped"; reason: string }
  | { kind: "no_manifest"; key: string; commands: string }
  | { kind: "failed"; key: string; reason: string };

const READY_ATTEMPTS = 30;
const READY_INTERVAL_MS = 1000;

/** `null` means no config could be loaded — the user still has to hear about it. */
export function notify(cfg: Config | null, title: string, body: string): void {
  if (title.length === 0) return;
  if (cfg !== null && !cfg.notify) return;
  try {
    Bun.spawnSync([herdrBin(), "notification", "show", title, "--body", body], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    log("notify", `failed to show "${title}": ${(error as Error).message}`);
  }
}

/** One wording for all three call sites, carrying no config path into a toast. */
export function missingBinReason(bin: string): string {
  return `${bin} not found — set magictree_bin in the plugin config`;
}

export function missingManifestCommands(path: string): string {
  return [`cd ${renderCommand([path])}`, "magictree discover", "magictree init"].join("\n");
}

function fail(key: string, path: string, req: StartRequest, reason: string): StartOutcome {
  updateRecord(key, {
    path,
    status: "failed",
    branch: req.branch,
    label: req.label,
    workspace_id: req.workspaceId,
    finished_at_ms: Date.now(),
    pid: null,
    error: reason,
  });
  return { kind: "failed", key, reason };
}

/** The runner owns the lock and releases it; this is only for spawn failures. */
function releaseQuietly(key: string): void {
  try {
    releaseRunLock(key);
  } catch {
    // Nothing to release.
  }
}

export async function startStackRun(req: StartRequest): Promise<StartOutcome> {
  const key = runKey(req.path);

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig();
  } catch (error) {
    const reason =
      error instanceof ConfigError ? error.message : `cannot load config: ${(error as Error).message}`;
    log("start", reason);
    updateRecord("config", { path: req.path, status: "failed", error: reason, finished_at_ms: Date.now() });
    notify(null, "Bad config", reason);
    return { kind: "failed", key: "config", reason };
  }
  const cfg = loaded.config;

  if (!cfg.enabled && req.trigger === "hook") {
    log("start", `disabled; ignoring ${req.path}`);
    return { kind: "skipped", reason: "plugin disabled" };
  }

  if (resolveBin(cfg) === null) {
    const reason = missingBinReason(cfg.magictreeBin);
    notify(cfg, "Magictree not found", reason);
    return fail(key, req.path, req, reason);
  }

  let ready = isWorktreeReady(req.path);
  for (let attempt = 0; !ready && attempt < READY_ATTEMPTS; attempt++) {
    await Bun.sleep(READY_INTERVAL_MS);
    ready = isWorktreeReady(req.path);
  }
  if (!ready) return fail(key, req.path, req, `worktree not usable after 30s: ${req.path}`);

  const root = repoRoot(req.path);
  if (root === null) return fail(key, req.path, req, `not a git worktree: ${req.path}`);

  if (!existsSync(manifestPath(root))) {
    if (cfg.missingManifest === "skip") {
      updateRecord(key, {
        path: req.path,
        status: "skipped",
        branch: req.branch,
        label: req.label,
        workspace_id: req.workspaceId,
        finished_at_ms: Date.now(),
        pid: null,
        error: "no magictree.toml",
      });
      log("start", `no magictree.toml in ${root}; recorded as skipped`);
      return { kind: "skipped", reason: "no magictree.toml" };
    }

    const commands = missingManifestCommands(req.path);
    updateRecord(key, {
      path: req.path,
      status: "no_manifest",
      branch: req.branch,
      label: req.label,
      workspace_id: req.workspaceId,
      finished_at_ms: Date.now(),
      pid: null,
      command: commands,
      error: null,
    });
    notify(cfg, "Not onboarded", "magictree not initialized — run magictree discover, then magictree init");
    return { kind: "no_manifest", key, commands };
  }

  const lock = acquireRunLock(key);
  if (!lock.ok) {
    const reason = `already running (pid ${lock.pid ?? "unknown"})`;
    log("start", `${req.path}: ${reason}`);
    return { kind: "skipped", reason };
  }

  const runLog = logPath(key);
  let pid: number | null = null;
  try {
    mkdirSync(dirname(runLog), { recursive: true });
    const fd = openSync(runLog, "a");
    try {
      const child = spawn(process.execPath, ["run", join(pluginRoot(), "src/up.ts")], {
        cwd: pluginRoot(),
        env: {
          ...process.env,
          MAGICTREE_RUN_KEY: key,
          MAGICTREE_TARGET_PATH: req.path,
          MAGICTREE_TARGET_LABEL: req.label ?? "",
          MAGICTREE_TARGET_BRANCH: req.branch ?? "",
          MAGICTREE_WORKSPACE_ID: req.workspaceId ?? "",
        },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      pid = child.pid ?? null;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    releaseQuietly(key);
    return fail(key, req.path, req, `could not spawn runner: ${(error as Error).message}`);
  }

  if (pid === null) {
    releaseQuietly(key);
    return fail(key, req.path, req, "could not spawn runner: no pid");
  }

  updateRecord(key, {
    path: req.path,
    status: "running",
    branch: req.branch,
    label: req.label,
    workspace_id: req.workspaceId,
    repo_root: repositoryRoot(req.path),
    started_at_ms: Date.now(),
    finished_at_ms: null,
    pid,
    log_path: runLog,
    command: renderCommand(upCommand(cfg, req.path)),
    error: null,
  });

  notify(cfg, "Starting stack", req.label ?? req.branch ?? basename(req.path));
  log("start", `started ${req.path} as pid ${pid} (log ${runLog})`);
  return { kind: "started", key, pid, logPath: runLog };
}
