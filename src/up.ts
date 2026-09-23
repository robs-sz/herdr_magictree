/**
 * The detached runner: one process per `magictree up`.
 *
 * `src/start.ts` spawns this with stdout and stderr already pointed at
 * `logs/<key>.log`, so `stdio: "inherit"` here is what makes the whole
 * bootstrap transcript land in the run log. This process owns the run lock and
 * is the only writer of the `ready`/`failed` terminal states.
 *
 * It also reports the run's progress as a sidebar badge, which is where a
 * bootstrap that takes minutes stays visible without taking the keyboard.
 */
import { basename } from "node:path";
import { loadConfig, type Config, type LoadedConfig } from "./config.ts";
import { elapsedText, log } from "./log.ts";
import {
  onboarded,
  parsePorts,
  portsCommand,
  renderCommand,
  resolveBin,
  upCommand,
} from "./magictree.ts";
import { logPath } from "./paths.ts";
import { lastLogLine, startProgressBadge } from "./progress-badge.ts";
import { missingBinReason, notify } from "./start.ts";
import { releaseRunLock, updateRecord } from "./state.ts";

const TERM_GRACE_MS = 10_000;
const PORTS_TIMEOUT_MS = 10_000;

/** Set once the badge starts; every exit path clears the sidebar label through it. */
let stopBadge: (() => void) | null = null;

/**
 * The workspace voice that runs alongside the sidebar badge. Herdr toasts live
 * three seconds and cannot be replaced while visible, so reassurance is
 * sparse: one at a minute, then one every five. Anything faster only collides
 * with its predecessor.
 */
const HEARTBEAT_FIRST_MS = 60_000;
const HEARTBEAT_EVERY_MS = 300_000;

/** Exit code, or `null` when the promise outlived `ms`. */
async function settle(promise: Promise<number>, ms: number): Promise<number | null> {
  const timeout = Promise.withResolvers<null>();
  const timer = setTimeout(() => timeout.resolve(null), ms);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `magictree up` can take minutes, and the start toast is gone after three
 * seconds. The sidebar badge is the live indicator, but it only shows in the
 * sidebar row; emit one "still starting" toast per threshold until the run
 * settles so a run reads as alive in the workspace too.
 */
function startHeartbeat(cfg: Config, label: string): () => void {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      notify(cfg, "Stack still starting", `${label} — ${elapsedText(Date.now() - startedAt)}`);
      log("up", `heartbeat at ${elapsedText(Date.now() - startedAt)}`);
      schedule(HEARTBEAT_EVERY_MS);
    }, delay);
  };
  schedule(HEARTBEAT_FIRST_MS);
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}

/** Terminal failure: record it, tell the user, drop the badge, drop the lock, exit non-zero. */
function finish(
  key: string,
  path: string,
  cfg: Config | null,
  title: string,
  error: string,
): never {
  stopBadge?.();
  updateRecord(key, { path, status: "failed", finished_at_ms: Date.now(), pid: null, error });
  notify(cfg, title, error);
  releaseRunLock(key);
  log("up", `failed ${path}: ${error}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const key = process.env.MAGICTREE_RUN_KEY;
  const path = process.env.MAGICTREE_TARGET_PATH;
  if (!key || !path) {
    log("up", `missing MAGICTREE_RUN_KEY/MAGICTREE_TARGET_PATH (key=${key ?? "-"} path=${path ?? "-"})`);
    process.exit(1);
  }

  const label = process.env.MAGICTREE_TARGET_LABEL || basename(path);
  const workspaceId = process.env.MAGICTREE_WORKSPACE_ID || null;
  const branch = process.env.MAGICTREE_TARGET_BRANCH || null;
  const runLog = logPath(key);

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig();
  } catch (error) {
    finish(key, path, null, "Stack failed", `${label} — ${(error as Error).message}`);
  }
  const cfg: Config = loaded.config;

  updateRecord(key, {
    path,
    status: "running",
    pid: process.pid,
    started_at_ms: Date.now(),
    finished_at_ms: null,
    error: null,
    log_path: runLog,
    workspace_id: workspaceId,
    branch,
  });

  if (resolveBin(cfg) === null) {
    const reason = missingBinReason(cfg.magictreeBin);
    finish(key, path, cfg, "Magictree not found", reason);
  }

  // The sidebar badge is the loading indicator for this run: display-only
  // metadata, so the keyboard stays with the user's pane. When Herdr cannot
  // badge (no workspace, no reachable server), a start toast at least says so.
  const startedAt = Date.now();
  stopBadge = startProgressBadge(workspaceId, label, startedAt, lastLogLine(runLog));
  if (stopBadge === null) notify(cfg, "Starting stack", label);

  const proc = Bun.spawn(upCommand(cfg, path), {
    cwd: path,
    env: { ...process.env },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const timeoutMs = cfg.upTimeoutSecs * 1000;
  const stopHeartbeat = startHeartbeat(cfg, label);
  let code: number | null;
  try {
    code = await settle(proc.exited, timeoutMs);
  } finally {
    stopHeartbeat();
  }

  if (code === null) {
    proc.kill("SIGTERM");
    if ((await settle(proc.exited, TERM_GRACE_MS)) === null) proc.kill("SIGKILL");
    finish(key, path, cfg, "Stack failed", `${label} — timed out after ${cfg.upTimeoutSecs}s`);
  }

  if (code === 0) {
    const ports = Bun.spawnSync(portsCommand(cfg, path), {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
      timeout: PORTS_TIMEOUT_MS,
    });
    // Bun leaves `signalCode` undefined (not null) on a clean exit; `success`
    // is the honest "exited cleanly" test.
    if (!ports.success) {
      log("up", `magictree ports did not exit cleanly (exit ${ports.exitCode ?? "-"} signal ${ports.signalCode ?? "-"})`);
    }
    const { services, unparsed } = parsePorts(ports.stdout.toString());
    for (const line of unparsed) log("up", `unparsed ports line: ${line}`);

    updateRecord(key, {
      path,
      status: "ready",
      finished_at_ms: Date.now(),
      pid: null,
      services,
      error: null,
      command: renderCommand(upCommand(cfg, path)),
    });

    const summary =
      services.length > 0
        ? `${services.length} service${services.length === 1 ? "" : "s"} up — magictree status to see the ports`
        : "stack up — magictree status to see the ports";
    notify(cfg, "Stack ready", summary);
    stopBadge?.();
    releaseRunLock(key);
    log("up", `ready ${path}: ${summary}`);
    process.exit(0);
  }

  const detail = lastLogLine(runLog)() || `magictree up exited with code ${code}`;
  finish(key, path, cfg, "Stack failed", `${label} — ${onboarded(path) ? detail : `not onboarded: ${detail}`}`);
}

void main();
