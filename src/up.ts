/**
 * The detached runner: one process per `magictree up`.
 *
 * `src/start.ts` spawns this with stdout and stderr already pointed at
 * `logs/<key>.log`, so `stdio: "inherit"` here is what makes the whole
 * bootstrap transcript land in the run log. This process owns the run lock and
 * is the only writer of the `ready`/`failed` terminal states.
 */
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig, type Config, type LoadedConfig } from "./config.ts";
import { log } from "./log.ts";
import {
  onboarded,
  parsePorts,
  portsCommand,
  renderCommand,
  resolveBin,
  upCommand,
} from "./magictree.ts";
import { logPath } from "./paths.ts";
import { notify } from "./start.ts";
import { releaseRunLock, updateRecord } from "./state.ts";

const TERM_GRACE_MS = 10_000;
const ERROR_CAP = 300;

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

function lastLogLine(path: string): string {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line.length === 0) continue;
      return line.length > ERROR_CAP ? `${line.slice(0, ERROR_CAP - 3)}...` : line;
    }
  } catch {
    // Unreadable run log; the caller falls back to the exit code.
  }
  return "";
}

/** Terminal failure: record it, tell the user, drop the lock, exit non-zero. */
function finish(
  key: string,
  path: string,
  cfg: Config | null,
  title: string,
  error: string,
): never {
  updateRecord(key, { path, status: "failed", finished_at_ms: Date.now(), pid: null, error });
  notify(cfg, title, `${error} (log: ${logPath(key)})`);
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
    finish(key, path, null, "magictree: stack failed", `${label} — ${(error as Error).message}`);
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
    const reason = `magictree not found: ${cfg.magictreeBin} (set magictree_bin in ${loaded.path})`;
    finish(key, path, cfg, "magictree: magictree missing", reason);
  }

  const proc = Bun.spawn(upCommand(cfg, path), {
    cwd: path,
    env: { ...process.env },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const timeoutMs = cfg.upTimeoutSecs * 1000;
  const code = await settle(proc.exited, timeoutMs);

  if (code === null) {
    proc.kill("SIGTERM");
    if ((await settle(proc.exited, TERM_GRACE_MS)) === null) proc.kill("SIGKILL");
    finish(key, path, cfg, "magictree: stack failed", `${label} — timed out after ${cfg.upTimeoutSecs}s`);
  }

  if (code === 0) {
    const ports = Bun.spawnSync(portsCommand(cfg, path), { cwd: path, stdout: "pipe", stderr: "pipe" });
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
        ? `${services.length} service${services.length === 1 ? "" : "s"} — ${services
            .slice(0, 3)
            .map((service) => service.url)
            .join(", ")}`
        : "stack up";
    notify(cfg, "magictree: stack ready", `${label} — ${summary}`);
    releaseRunLock(key);
    log("up", `ready ${path}: ${summary}`);
    process.exit(0);
  }

  const detail = lastLogLine(runLog) || `magictree up exited with code ${code}`;
  finish(key, path, cfg, "magictree: stack failed", `${label} — ${onboarded(path) ? detail : `not onboarded: ${detail}`}`);
}

void main();
