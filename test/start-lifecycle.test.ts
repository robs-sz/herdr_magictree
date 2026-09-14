/**
 * The start→runner lifecycle: the only place in the plugin where two processes
 * contend over the same worktree. These tests drive the real detached runner
 * (`src/up.ts`) against fake `magictree`/`herdr` binaries, so the run-lock
 * handoff and the ready transition are observed end to end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath } from "../src/config.ts";
import { runLockPath } from "../src/paths.ts";
import { startStackRun } from "../src/start.ts";
import { acquireRunLock, readState, releaseRunLock, runKey, type WorktreeRecord } from "../src/state.ts";

let dir: string;
let repo: string;

/** Stands in for `magictree`: `up` sleeps then exits 0, `ports` prints one row. */
function fakeMagictree(upSleepSecs: number): string {
  const bin = join(dir, "magictree");
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  up) sleep ${upSleepSecs}; exit 0 ;;
  ports) echo "id  port  url"; echo "web  3000  http://localhost:3000"; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Stands in for `herdr` (records argv, exits 0). Without it the notifications
 * these tests provoke would land in the user's live Herdr session.
 */
function fakeHerdr(): string {
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${join(dir, "herdr.log")}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-start-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "magictree.toml"), "");
  if (Bun.spawnSync(["git", "init", "-q", repo]).exitCode !== 0) throw new Error("git init failed");
  process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(dir, "config");
  process.env.HERDR_BIN_PATH = fakeHerdr();
  writeFileSync(configPath(), `magictree_bin = "${fakeMagictree(2)}"\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  delete process.env.HERDR_BIN_PATH;
});

describe("startStackRun", () => {
  test("hands the run lock to the runner, skips a concurrent start, and releases on ready", async () => {
    const key = runKey(repo);
    const req = { path: repo, branch: "main", label: "demo", workspaceId: null, trigger: "hook" as const };

    const outcome = await startStackRun(req);
    if (outcome.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(outcome)}`);
    expect(outcome.pid).not.toBeNull();

    // The lock names the runner, not this process — which returns immediately.
    // A lock naming the acquirer's pid reads as stale within a second and gets
    // stolen, starting a second runner over the same port block.
    expect(readFileSync(runLockPath(key), "utf8").trim()).toBe(String(outcome.pid));

    const again = await startStackRun(req);
    if (again.kind !== "skipped") throw new Error(`expected skipped, got ${JSON.stringify(again)}`);
    expect(again.reason).toContain("already running");

    // The runner settles the run to "ready" (services parsed from `ports`)
    // and drops the lock, so the next start is not blocked.
    //
    // Real-timer exception (ts-no-test-timers): the state change happens in a
    // detached child process — fake timers cannot advance its clock and no
    // promise bridges the process boundary, so polling the state file is the
    // only available signal.
    const deadline = Date.now() + 20_000;
    let record: WorktreeRecord | undefined;
    let lockGone = false;
    while (Date.now() < deadline) {
      record = readState().worktrees[key];
      lockGone = !existsSync(runLockPath(key));
      if (record?.status === "ready" && lockGone) break;
      await Bun.sleep(200);
    }
    expect(record?.status).toBe("ready");
    expect(record?.services).toEqual([{ id: "web", port: 3000, url: "http://localhost:3000" }]);
    expect(lockGone).toBe(true);

    expect(acquireRunLock(key)).toEqual({ ok: true });
    releaseRunLock(key);
  }, 30_000);

  test("records a config failure under the worktree key, not a synthetic one", async () => {
    writeFileSync(configPath(), "up_timeout_secs = 0\n");
    const key = runKey(repo);

    const outcome = await startStackRun({
      path: repo,
      branch: "main",
      label: null,
      workspaceId: null,
      trigger: "hook",
    });
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${JSON.stringify(outcome)}`);
    expect(outcome.key).toBe(key);
    expect(outcome.reason).toContain("up_timeout_secs");
    expect(readState().worktrees[key]?.status).toBe("failed");
  });
});
