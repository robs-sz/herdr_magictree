import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath } from "../src/config.ts";
import { collectWorktree } from "../src/teardown.ts";
import { readState, runKey, updateRecord } from "../src/state.ts";

let dir: string;
let repo: string;
let argvLog: string;

/** Stands in for `magictree`: records its argv and exits with `exitCode`. */
function fakeMagictree(exitCode: number): string {
  const bin = join(dir, "magictree");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\necho "released block 25820-25821 (worktree example)"\nexit ${exitCode}\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function writeConfig(lines: string): void {
  writeFileSync(configPath(), lines);
}

function invocations(): string[] {
  return existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean) : [];
}

function recordFor(worktree: string, repoRoot: string | null): string {
  const key = runKey(worktree);
  updateRecord(key, { path: worktree, status: "ready", repo_root: repoRoot });
  return key;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-teardown-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  argvLog = join(dir, "argv.log");
  process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(dir, "config");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_PLUGIN_CONFIG_DIR;
});

describe("collectWorktree", () => {
  test("reclaims through magictree gc and forgets the worktree", () => {
    const worktree = join(dir, "checkout");
    const key = recordFor(worktree, repo);
    writeConfig(`magictree_bin = "${fakeMagictree(0)}"\nnotify = false\n`);

    const outcome = collectWorktree({
      path: worktree,
      label: "example",
      branch: "feat/x",
      workspaceId: "w1",
      repoRoot: repo,
    });

    expect(outcome).toEqual({
      kind: "reclaimed",
      key,
      repoRoot: repo,
      lines: ["released block 25820-25821 (worktree example)"],
    });
    expect(invocations()).toEqual([`gc --cwd ${repo}`]);
    expect(readState().worktrees[key]).toBeUndefined();
  });

  test("falls back to the recorded repository when the event omits it", () => {
    const worktree = join(dir, "checkout");
    const key = recordFor(worktree, repo);
    writeConfig(`magictree_bin = "${fakeMagictree(0)}"\nnotify = false\n`);

    expect(collectWorktree({ path: worktree, label: null, branch: null, workspaceId: null, repoRoot: null }).kind).toBe(
      "reclaimed",
    );
    expect(invocations()).toEqual([`gc --cwd ${repo}`]);
    expect(readState().worktrees[key]).toBeUndefined();
  });

  test("a failing gc keeps the record so the worktree is not silently forgotten", () => {
    const worktree = join(dir, "checkout");
    const key = recordFor(worktree, repo);
    writeConfig(`magictree_bin = "${fakeMagictree(3)}"\nnotify = false\n`);

    const outcome = collectWorktree({
      path: worktree,
      label: null,
      branch: null,
      workspaceId: null,
      repoRoot: repo,
    });

    expect(outcome.kind).toBe("failed");
    const record = readState().worktrees[key]!;
    expect(record.status).toBe("failed");
    expect(record.error).toContain("3");
  });

  test("a worktree this plugin never started is left alone", () => {
    writeConfig(`magictree_bin = "${fakeMagictree(0)}"\nnotify = false\n`);

    expect(
      collectWorktree({ path: join(dir, "untouched"), label: null, branch: null, workspaceId: null, repoRoot: repo }),
    ).toEqual({ kind: "skipped", reason: "no record" });
    expect(invocations()).toEqual([]);
  });

  test("the removal hook can be turned off", () => {
    const worktree = join(dir, "checkout");
    const key = recordFor(worktree, repo);
    writeConfig(`magictree_bin = "${fakeMagictree(0)}"\nnotify = false\non_worktree_removed = false\n`);

    expect(
      collectWorktree({ path: worktree, label: null, branch: null, workspaceId: null, repoRoot: repo }),
    ).toEqual({ kind: "skipped", reason: "plugin disabled" });
    expect(invocations()).toEqual([]);
    expect(readState().worktrees[key]).toBeDefined();
  });

  test("an unreadable config is reported, not thrown", () => {
    writeConfig("not = valid = toml\n");
    expect(collectWorktree({ path: join(dir, "checkout"), label: null, branch: null, workspaceId: null, repoRoot: repo }).kind).toBe(
      "failed",
    );
  });
});
