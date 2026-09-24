/**
 * Open an unfocused split below the workspace pane and show live stack progress.
 *
 * The runner is detached from Herdr's UI, so this separate plugin pane owns the
 * display. It polls the run record and log, then exits when the run settles.
 * Failure to open the pane is best-effort: the runner falls back to toasts.
 */
import { capLine, log } from "./log.ts";
import { herdrBin } from "./paths.ts";

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** One `herdr` call, parsed. Any failure — including a non-JSON reply — is logged and `null`. */
function call(args: string[]): Json | null {
  let stdout: string;
  let stderr: string;
  let code: number | null;
  try {
    const proc = Bun.spawnSync([herdrBin(), ...args], { stdout: "pipe", stderr: "pipe" });
    stdout = proc.stdout.toString();
    stderr = proc.stderr.toString();
    code = proc.exitCode;
  } catch (error) {
    log("progress", `herdr ${args.join(" ")} could not run: ${(error as Error).message}`);
    return null;
  }

  if (code !== 0) {
    log("progress", `herdr ${args.join(" ")} exited ${code}: ${capLine(stderr.trim())}`);
    return null;
  }

  try {
    return asObject(JSON.parse(stdout) as unknown);
  } catch {
    log("progress", `herdr ${args.join(" ")} did not answer with JSON: ${capLine(stdout.trim())}`);
    return null;
  }
}

/** `true` when Herdr opened the pane; `false` asks the caller to use toasts. */
export function openProgressPane(key: string, workspaceId: string | null): boolean {
  if (workspaceId === null) {
    log("progress", `no workspace for ${key}; using notifications instead`);
    return false;
  }

  const listed = call(["pane", "list", "--workspace", workspaceId]);
  const panes = asObject(listed?.result)?.panes;
  let targetPane: string | null = null;
  if (Array.isArray(panes)) {
    for (const value of panes) {
      const pane = asObject(value);
      if (typeof pane?.pane_id !== "string") continue;
      if (targetPane === null) targetPane = pane.pane_id;
      if (pane.focused === true) {
        targetPane = pane.pane_id;
        break;
      }
    }
  }
  if (targetPane === null) {
    log("progress", `Herdr found no pane in workspace ${workspaceId}; using notifications instead`);
    return false;
  }

  const opened = call([
    "plugin",
    "pane",
    "open",
    "--plugin",
    "magictree",
    "--entrypoint",
    "progress",
    "--target-pane",
    targetPane,
    "--placement",
    "split",
    "--direction",
    "down",
    "--no-focus",
    "--env",
    `MAGICTREE_RUN_KEY=${key}`,
  ]);

  const result = asObject(opened?.result);
  if (result?.type !== "ok" && result?.type !== "plugin_pane_opened") {
    log("progress", `Herdr opened no progress pane for ${key}`);
    return false;
  }

  // A maximal downward resize makes Herdr clamp the bottom pane to its minimum.
  const resized = call(["pane", "resize", "--pane", targetPane, "--direction", "down", "--amount", "1.0"]);
  if (asObject(resized?.result)?.type !== "pane_resize") {
    log("progress", `Herdr could not shrink progress pane ${key} to minimum height`);
  }

  log("progress", `watching ${key} in an unfocused bottom split in ${workspaceId}`);
  return true;
}
