import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, repositoryRoot } from "../src/magictree.ts";

/**
 * These two roots differ for a linked worktree, and `magictree gc` needs the
 * repository one: pointed at a checkout it reconciles nothing, because the very
 * checkout it is given is the one that was deleted.
 */
let dir: string;
let main: string;
let linked: string;

function run(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-roots-"));
  main = join(dir, "repo");
  linked = join(dir, "checkout");
  mkdirSync(main, { recursive: true });
  run(["init", "-b", "main", "-q"], main);
  writeFileSync(join(main, "README.md"), "roots\n");
  run(["add", "-A"], main);
  run(["-c", "user.email=t@e", "-c", "user.name=test", "commit", "-qm", "init"], main);
  run(["worktree", "add", "-q", "-b", "side", linked], main);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("repository roots", () => {
  test("a linked worktree's checkout root is not its repository root", () => {
    expect(repoRoot(linked)).not.toBe(repositoryRoot(linked));
    expect(repositoryRoot(linked)!.endsWith("/repo")).toBe(true);
  });

  test("the repository root is stable across the main checkout and its worktrees", () => {
    expect(repositoryRoot(linked)).toBe(repositoryRoot(main));
  });

  test("a path that is not a repository yields nothing", () => {
    expect(repositoryRoot(join(dir, "nope"))).toBeNull();
  });
});
