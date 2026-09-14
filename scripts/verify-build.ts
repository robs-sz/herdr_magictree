/**
 * The `herdr plugin install` build phase, run without Herdr: every `[[build]]`
 * command in the manifest, in order, with the plugin root as cwd, aborting on
 * the first non-zero exit exactly as install does. Item-level `platforms`
 * override the top-level list, and a step that does not cover this platform is
 * skipped rather than run.
 *
 * `magictree` is the only external tool a build step needs and it is not
 * installable on a clean runner, so a stub stands in for it. What this catches
 * is the failure no other check would: a build entry pointing at a moved or
 * misnamed file in this repository.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};
const PLATFORM: string | null = PLATFORMS[process.platform] ?? null;

const root = join(import.meta.dir, "..");
const manifest = parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8")) as Record<string, unknown>;
const topLevelPlatforms = manifest.platforms;

function runsHere(step: Record<string, unknown>): boolean {
  const declared = step.platforms ?? topLevelPlatforms;
  if (!Array.isArray(declared) || PLATFORM === null) return true;
  return declared.includes(PLATFORM);
}

function argvOf(step: Record<string, unknown>): string[] {
  const command = step.command;
  if (!Array.isArray(command) || command.some((arg) => typeof arg !== "string")) {
    throw new Error(`[[build]] command must be an argv array of strings: ${JSON.stringify(step)}`);
  }
  return command;
}

const steps = Array.isArray(manifest.build) ? (manifest.build as Record<string, unknown>[]) : [];

const stubDir = mkdtempSync(join(tmpdir(), "build-phase-"));
const stub = join(stubDir, "magictree");
writeFileSync(stub, "#!/bin/sh\nexit 0\n");
chmodSync(stub, 0o755);

const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` };
let failed: string[] | null = null;

try {
  for (const step of steps) {
    const argv = argvOf(step);
    if (!runsHere(step)) {
      process.stdout.write(`skip (not ${PLATFORM}): ${argv.join(" ")}\n`);
      continue;
    }
    process.stdout.write(`$ ${argv.join(" ")}\n`);
    const proc = Bun.spawnSync(argv, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
    if (proc.exitCode !== 0) {
      failed = argv;
      break;
    }
  }
} finally {
  rmSync(stubDir, { recursive: true, force: true });
}

if (failed !== null) {
  process.stderr.write(`build step failed: ${failed.join(" ")}\n`);
  process.exit(1);
}

process.stdout.write(`build phase ok: ${steps.length} step(s)\n`);
