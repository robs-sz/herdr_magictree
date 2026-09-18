/**
 * The progress pane's one contract: it lives exactly as long as the run.
 *
 * A spinner that outlives its run is worse than no spinner, and one that quits
 * early leaves a bootstrap looking dead again — the two failures this file
 * pins. The pane is driven as a real child process against a real state file,
 * because both are what it actually reads.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logPath } from "../src/paths.ts";
import { runKey, updateRecord } from "../src/state.ts";

let dir: string;
let stateDir: string;
let child: Bun.Subprocess | null = null;

const REPO = "/tmp/mth-progress-repo";

/** Real-timer exception (ts-no-test-timers): the pane polls a file from another process. */
function pane(key: string): Bun.Subprocess {
  child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "progress-pane.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      MAGICTREE_RUN_KEY: key,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return child;
}

async function exitedWithin(proc: Bun.Subprocess, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

function output(proc: Bun.Subprocess): Promise<string> {
  return new Response(proc.stdout as ReadableStream).text();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-progress-"));
  stateDir = join(dir, "state");
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  mkdirSync(join(stateDir, "logs"), { recursive: true });
});

afterEach(() => {
  child?.kill();
  child = null;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_STATE_DIR;
});

describe("progress pane", () => {
  test("spins while the run is live and quits when it settles", async () => {
    const key = runKey(REPO);
    writeFileSync(logPath(key), "pulling postgres:16\n");
    // A live pid is what tells the pane its runner is still there.
    updateRecord(key, { path: REPO, status: "running", pid: process.pid, label: "demo", started_at_ms: Date.now() });

    const proc = pane(key);
    expect(await exitedWithin(proc, 2000)).toBe(false);

    updateRecord(key, { path: REPO, status: "ready", pid: null, finished_at_ms: Date.now() });
    expect(await exitedWithin(proc, 5000)).toBe(true);

    const frames = await output(proc);
    expect(frames).toContain("starting demo");
    expect(frames).toContain("pulling postgres:16");
  }, 20_000);

  test("quits when the runner behind the run is gone", async () => {
    const key = runKey(REPO);
    // A pid that has certainly exited: the pane must not spin for a dead runner.
    const dead = Bun.spawn(["true"], { stdout: "ignore" });
    await dead.exited;
    updateRecord(key, { path: REPO, status: "running", pid: dead.pid, label: "demo", started_at_ms: Date.now() });

    const proc = pane(key);
    expect(await exitedWithin(proc, 5000)).toBe(true);
    expect(proc.exitCode).toBe(1);
  }, 20_000);
});
