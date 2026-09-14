import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The install gate. `herdr plugin install` aborts on a non-zero build exit, so
 * these two cases are the whole contract: a present binary lets an install
 * through, a missing one stops it and says why.
 */
const script = join(import.meta.dir, "..", "src", "require-magictree.ts");

let dir: string;
let pathDir: string;

function run(): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, script], {
    env: { PATH: pathDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-require-"));
  pathDir = join(dir, "bin");
  mkdirSync(pathDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("magictree requirement", () => {
  test("a magictree on PATH passes the install check", () => {
    const bin = join(pathDir, "magictree");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);

    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(bin);
  });

  test("a missing magictree fails the install and names the reason", () => {
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found on PATH");
  });
});
