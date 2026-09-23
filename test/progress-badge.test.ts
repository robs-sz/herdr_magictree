/**
 * The badge's one contract: a `working` state label that appears while the run
 * is live and is cleared when the caller stops it.
 *
 * The reporter runs in-process against a stub `herdr` binary, because what it
 * must prove is the sequence of `herdr` calls, and that is exactly what the
 * stub records. Fake timers drive the refresh interval deterministically.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProgressBadge } from "../src/progress-badge.ts";

let dir: string;

/** A fake `herdr`: `HERDR_TEST_PANES` shapes the pane list; metadata calls are recorded. */
function stubHerdr(): string {
  const bin = join(dir, "herdr-stub.ts");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "pane" && args[1] === "list") {
  const panes = process.env.HERDR_TEST_PANES ?? '[{"pane_id":"w1:p1","focused":false}]';
  process.stdout.write(JSON.stringify({ result: { panes: JSON.parse(panes) } }));
} else {
  appendFileSync(process.env.HERDR_TEST_META_LOG!, JSON.stringify(args) + "\\n");
  process.stdout.write(JSON.stringify({ result: { type: "ok" } }));
}
`,
    );
  chmodSync(bin, 0o755);
  return bin;
}

let calls: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-badge-"));
  calls = join(dir, "calls.log");
  process.env.HERDR_BIN_PATH = stubHerdr();
  process.env.HERDR_TEST_META_LOG = calls;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_TEST_META_LOG;
  delete process.env.HERDR_TEST_PANES;
  rmSync(dir, { recursive: true, force: true });
});

function reports(): string[] {
  return readFileSync(calls, "utf8")
    .split("\n")
    .filter((line) => line.includes("report-metadata"));
}

describe("progress badge", () => {
  test("reports a working state label, refreshes it, and clears it on stop", () => {
    const stop = startProgressBadge("w1", "demo", Date.now(), () => "building web image");
    if (stop === null) throw new Error("badge did not start");

    vi.advanceTimersByTime(2000);
    stop();

    const recorded = reports();
    expect(recorded.length).toBe(3); // initial report + one refresh + clear
    expect(recorded[0]).toContain('"--source","magictree-up"');
    expect(recorded[0]).toContain('"--state-label","working=');
    expect(recorded[0]).toContain("up demo ");
    expect(recorded[0]).toContain("building web image");
    expect(recorded[2]).toContain("--clear-state-labels");
    expect(recorded[2]).not.toContain("--state-label");
  });

  test("returns null when the workspace has no panes to badge", () => {
    process.env.HERDR_TEST_PANES = "[]";
    expect(startProgressBadge("w1", "demo", Date.now(), () => "")).toBeNull();
  });

  test("returns null without a workspace", () => {
    expect(startProgressBadge(null, "demo", Date.now(), () => "")).toBeNull();
  });
});
