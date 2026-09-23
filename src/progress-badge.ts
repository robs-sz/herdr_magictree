/**
 * The run's sidebar badge: a `working` state label on one pane of the run's
 * workspace, refreshed while `magictree up` runs and cleared when it settles.
 *
 * This replaces the old modal progress popup. A popup receives all terminal
 * input — it blocks the session until a keypress dismisses it — while a state
 * label is display-only metadata: the sidebar keeps showing the run's label and
 * elapsed time, and the keyboard never leaves the user's pane.
 *
 * The reporter lives inside the runner process; there is no separate spinner
 * process to keep alive, and a label can never outlive its run because the
 * runner clears it on every exit path before exiting itself.
 */
import { readFileSync } from "node:fs";
import { herdrBin } from "./paths.ts";
import { capLine, elapsedText, log } from "./log.ts";

/** Sidebar state labels are capped at 80 characters by Herdr; stay under it. */
const LABEL_CAP = 80;
const UPDATE_MS = 2000;
const SOURCE = "magictree-up";

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** One `herdr` call, parsed. Any failure is logged and `null`. */
function call(args: string[]): Json | null {
  let stdout: string;
  let stderr: string;
  let code: number | null;
  try {
    const proc = Bun.spawnSync([herdrBin(), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    stdout = proc.stdout.toString();
    stderr = proc.stderr.toString();
    code = proc.exitCode;
  } catch (error) {
    log("progress", `herdr ${args.join(" ")} could not run: ${(error as Error).message}`);
    return null;
  }

  if (code !== 0) {
    log("progress", `herdr ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    return null;
  }

  let parsed: Json | null;
  try {
    parsed = asObject(JSON.parse(stdout) as unknown);
  } catch (error) {
    log("progress", `herdr ${args.join(" ")} returned invalid JSON: ${(error as Error).message}`);
    return null;
  }
  if (parsed === null) log("progress", `herdr ${args.join(" ")} did not answer with JSON`);
  return parsed;
}

function report(pane: string, text: string, clear: boolean): boolean {
  const args = ["pane", "report-metadata", pane, "--source", SOURCE];
  if (clear) args.push("--clear-state-labels");
  else args.push("--state-label", `working=${text}`);
  const opened = call(args);
  return opened !== null && asObject(opened.result)?.type === "ok";
}

/** The pane the badge attaches to: the focused pane of the workspace, else the first. */
function pickPane(workspaceId: string): string | null {
  const listed = call(["pane", "list", "--workspace", workspaceId]);
  const panes = listed === null ? [] : (listed.result as Json | undefined)?.panes;
  if (!Array.isArray(panes) || panes.length === 0) {
    log("progress", `workspace ${workspaceId} has no panes to badge`);
    return null;
  }
  const ids = panes
    .map((entry) => asObject(entry)?.pane_id)
    .filter((id): id is string => typeof id === "string");
  return ids.find((_, index) => asObject(panes[index])?.focused === true) ?? ids[0] ?? null;
}

/** `null` means no pane could be badged — the caller falls back to toasts. */
export function startProgressBadge(
  workspaceId: string | null,
  label: string,
  startedAt: number,
  lastLogLine: () => string,
): (() => void) | null {
  if (workspaceId === null || workspaceId.length === 0) return null;

  const pane = pickPane(workspaceId);
  if (pane === null) return null;

  const text = (): string => {
    const tail = lastLogLine();
    const plain = `up ${label} ${elapsedText(Date.now() - startedAt)}`;
    return capLine(tail.length > 0 ? `${plain} — ${tail}` : plain, LABEL_CAP);
  };

  if (!report(pane, text(), false)) return null;
  log("progress", `watching ${label} as a sidebar badge on ${pane}`);

  const timer = setInterval(() => report(pane, text(), false), UPDATE_MS);
  return (): void => {
    clearInterval(timer);
    // Best effort: a runner that exits must leave no stale `working` label.
    report(pane, "", true);
  };
}

/**
 * The last non-empty line of the run log, read from the tail of the file:
 * `magictree up` can write megabytes of build output.
 */
export function lastLogLine(path: string): () => string {
  return (): string => {
    try {
      const lines = readFileSync(path, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (line.length > 0) return capLine(line);
      }
    } catch {
      // Unreadable run log; the badge renders elapsed time only.
    }
    return "";
  };
}
