/**
 * Per-worktree run records, in one JSON file under the plugin state dir.
 *
 * Two locks live here. `state.lock` serialises read-modify-write of the whole
 * file (a hook and a manual action can land at the same instant). `runs/<key>.lock`
 * proves ownership of a live `magictree up`, so a second trigger is skipped
 * instead of starting a duplicate stack.
 *
 * Every write goes through a temp file plus rename: a crash mid-write leaves the
 * previous state intact, and a truly unparseable file is quarantined rather than
 * silently discarded.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.ts";
import { logPath, runLockPath, stateLockPath, statePath } from "./paths.ts";

export type RunStatus = "running" | "ready" | "failed" | "no_manifest" | "skipped" | "stopped";

export type Service = { id: string; port: number; url: string };

export type WorktreeRecord = {
  key: string;
  path: string;
  branch: string | null;
  label: string | null;
  workspace_id: string | null;
  repo_root: string | null;
  status: RunStatus;
  started_at_ms: number;
  finished_at_ms: number | null;
  pid: number | null;
  log_path: string;
  command: string;
  error: string | null;
  services: Service[];
};

export type State = { version: 1; worktrees: Record<string, WorktreeRecord> };

const LOCK_RETRY_MS = 20;
const LOCK_MAX_ATTEMPTS = 50;
const LOCK_STALE_MS = 10_000;

/** Readable, stable, and unique per checkout path: `<dirname>-<sha256[:8]>`. */
export function runKey(worktreePath: string): string {
  const name = worktreePath.split("/").filter(Boolean).pop() ?? "worktree";
  const slug = name.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `${slug}-${createHash("sha256").update(worktreePath).digest("hex").slice(0, 8)}`;
}

/**
 * Every field a record must have, so readers never have to guard for absence.
 * `startedAt` is the finish time for a record inserted directly as terminal
 * (no manifest, already running), so it never claims to have started *after* it
 * finished.
 */
function blankRecord(key: string, path: string, startedAt: number): WorktreeRecord {
  return {
    key,
    path,
    branch: null,
    label: null,
    workspace_id: null,
    repo_root: null,
    status: "skipped",
    started_at_ms: startedAt,
    finished_at_ms: null,
    pid: null,
    log_path: logPath(key),
    command: "",
    error: null,
    services: [],
  };
}

export function readState(): State {
  const path = statePath();
  if (!existsSync(path)) return { version: 1, worktrees: {} };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    log("state", `cannot read ${path}: ${(error as Error).message}`);
    return { version: 1, worktrees: {} };
  }

  try {
    const parsed = JSON.parse(text) as Partial<State> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.worktrees || typeof parsed.worktrees !== "object") {
      throw new Error("missing worktrees object");
    }
    const worktrees: Record<string, WorktreeRecord> = {};
    for (const [key, value] of Object.entries(parsed.worktrees)) {
      const stored = value as Partial<WorktreeRecord>;
      // Fills fields a record written by an older plugin version lacks.
      worktrees[key] = {
        ...blankRecord(key, typeof stored.path === "string" ? stored.path : "", stored.started_at_ms ?? Date.now()),
        ...stored,
        key,
      };
    }
    return { version: 1, worktrees };
  } catch (error) {
    const quarantine = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, quarantine);
      log("state", `unreadable ${path} (${(error as Error).message}) renamed to ${quarantine}`);
    } catch (renameError) {
      log("state", `unreadable ${path} (${(error as Error).message}); quarantine failed: ${(renameError as Error).message}`);
    }
    return { version: 1, worktrees: {} };
  }
}

function writeState(state: State): void {
  const path = statePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Runs `fn` holding `state.lock`. A lock older than `LOCK_STALE_MS` is assumed
 * to belong to a dead writer and is stolen. If the lock still cannot be taken
 * after ~1s, `fn` runs unlocked: a rare lost update beats dropping the record
 * entirely, and writers hold the lock for microseconds.
 */
function withStateLock<T>(fn: () => T): T {
  const lock = stateLockPath();
  let fd: number | null = null;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let mtimeMs: number | null = null;
      try {
        mtimeMs = statSync(lock).mtimeMs;
      } catch {
        // The owner released between the EEXIST and the stat: retry immediately.
      }
      if (mtimeMs !== null && Date.now() - mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }

  if (fd === null) log("state", `could not acquire ${lock} within 1s; writing unlocked`);

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed; nothing to do.
      }
    }
    if (fd !== null) rmSync(lock, { force: true });
  }
}

/** Upsert of one worktree record. `path` is required when the key is new. */
export function updateRecord(
  key: string,
  patch: Partial<WorktreeRecord> & { path?: string },
): WorktreeRecord {
  return withStateLock(() => {
    const state = readState();
    const existing = state.worktrees[key];
    if (!existing && typeof patch.path !== "string") {
      throw new Error(`updateRecord: new record ${key} needs a path`);
    }

    const base = existing ?? blankRecord(key, patch.path as string, patch.finished_at_ms ?? Date.now());

    const defined: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (value !== undefined) defined[field] = value;
    }

    const next = { ...base, ...defined, key } as WorktreeRecord;
    state.worktrees[key] = next;
    writeState(state);
    return next;
  });
}

export function findByWorkspace(state: State, workspaceId: string): WorktreeRecord | undefined {
  return Object.values(state.worktrees).find((record) => record.workspace_id === workspaceId);
}

/** Forgets a worktree whose checkout is gone. Returns false when there was nothing to forget. */
export function deleteRecord(key: string): boolean {
  return withStateLock(() => {
    const state = readState();
    if (!(key in state.worktrees)) return false;
    delete state.worktrees[key];
    writeState(state);
    return true;
  });
}

/** `EPERM` means the pid exists but belongs to another user: still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(lock: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireRunLock(key: string): { ok: true } | { ok: false; pid: number | null } {
  const lock = runLockPath(key);
  mkdirSync(dirname(lock), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = readLockPid(lock);
      if (pid !== null && pidAlive(pid)) return { ok: false, pid };
      rmSync(lock, { force: true });
    }
  }

  return { ok: false, pid: readLockPid(lock) };
}

export function releaseRunLock(key: string): void {
  rmSync(runLockPath(key), { force: true });
}

/**
 * Re-points the run lock at the runner's pid after the detached spawn. The
 * acquiring process (hook or action) exits immediately; without this the lock
 * names a dead pid within a second, the next trigger's staleness check steals
 * it, and a second `magictree up` starts over the same port block.
 */
export function claimRunLock(key: string, pid: number): void {
  const lock = runLockPath(key);
  if (!existsSync(lock)) return; // Released already: nothing to re-point.
  writeFileSync(lock, String(pid));
}
