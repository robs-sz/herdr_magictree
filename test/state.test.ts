import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, pidAlive, readState, releaseRunLock, runKey, updateRecord } from "../src/state.ts";
import { runLockPath, statePath } from "../src/paths.ts";

let dir: string;
const DEAD_PID = 1_073_741_824;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-state-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(dir, "config");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_PLUGIN_CONFIG_DIR;
});

describe("runKey", () => {
  test("is deterministic and path-distinguishing", () => {
    expect(runKey("/a/repo-x")).toBe(runKey("/a/repo-x"));
    expect(runKey("/a/repo-x")).not.toBe(runKey("/b/repo-x"));
    expect(runKey("/a/repo-x")).toStartWith("repo-x-");
  });
});

describe("updateRecord", () => {
  test("inserts, patches, and round-trips through readState", () => {
    updateRecord("k1", { path: "/wt", status: "running", pid: 42, label: "feat" });
    updateRecord("k1", { status: "ready", pid: null, services: [{ id: "web", port: 3150, url: "http://localhost:3150" }] });

    const record = readState().worktrees["k1"]!;
    expect(record.status).toBe("ready");
    expect(record.pid).toBeNull();
    expect(record.path).toBe("/wt");
    expect(record.label).toBe("feat");
    expect(record.services).toEqual([{ id: "web", port: 3150, url: "http://localhost:3150" }]);
    expect(existsSync(`${statePath()}.tmp`)).toBe(false);
  });

  test("a new record without a path is a programming error", () => {
    expect(() => updateRecord("k2", { status: "failed" })).toThrow(/needs a path/);
  });

  test("a record inserted directly as terminal does not start after it finished", () => {
    const record = updateRecord("k3", { path: "/wt", status: "no_manifest", finished_at_ms: Date.now() });
    expect(record.started_at_ms).toBeLessThanOrEqual(record.finished_at_ms!);
  });

  test("an unreadable state file is quarantined instead of losing every other record", () => {
    updateRecord("k1", { path: "/wt" });
    writeFileSync(statePath(), "{not json");
    expect(readState().worktrees).toEqual({});
    expect(existsSync(statePath())).toBe(false);
  });
});

describe("run lock", () => {
  test("a live owner blocks a second acquisition until release", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(acquireRunLock("k1")).toEqual({ ok: true });

    const second = acquireRunLock("k1");
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.pid).toBe(process.pid);

    releaseRunLock("k1");
    expect(acquireRunLock("k1")).toEqual({ ok: true });
  });

  test("a lock held by a dead pid is stolen", () => {
    expect(pidAlive(DEAD_PID)).toBe(false);
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(join(dir, "runs", "k1.lock"), String(DEAD_PID));

    expect(acquireRunLock("k1")).toEqual({ ok: true });
  });

  test("the lock records the acquiring pid", () => {
    acquireRunLock("k1");
    expect(Bun.file(runLockPath("k1")).text()).resolves.toBe(String(process.pid));
  });
});
