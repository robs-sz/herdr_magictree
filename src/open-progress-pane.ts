/**
 * Opening the progress pane.
 *
 * The pane is a compact popup, and that placement is the point: a popup is the
 * one surface Herdr draws with `palette.accent` regardless of focus, so a
 * background bootstrap nobody will ever focus still reads as active. Its
 * interior follows `panel_bg`, which this plugin's users typically point at
 * the terminal default, so the frame also matches the terminal's own scheme.
 *
 * Popups are session-modal: while it is up, keys go to the spinner, and any
 * keypress dismisses it — the run itself is detached and keeps going. When the
 * run settles the process exits, which closes the popup.
 *
 * Every failure returns `false` rather than throwing: the caller then falls
 * back to notifications, which is also the right answer when Herdr has no
 * foreground client to draw in or another modal (settings, copy mode, another
 * popup) is already open.
 */
import { capLine, log } from "./log.ts";
import { herdrBin } from "./paths.ts";

/** Two content rows inside the accent frame: the spinner and the run's last log line. */
const POPUP_ROWS = 4;
const POPUP_COLUMNS = 100;

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

/** `true` when Herdr drew the popup; `false` when the caller should notify instead. */
export function openProgressPane(key: string): boolean {
  const opened = call([
    "plugin",
    "pane",
    "open",
    "--plugin",
    "magictree",
    "--entrypoint",
    "progress",
    "--placement",
    "popup",
    "--width",
    String(POPUP_COLUMNS),
    "--height",
    String(POPUP_ROWS),
    "--env",
    `MAGICTREE_RUN_KEY=${key}`,
  ]);

  if (opened === null || asObject(opened.result)?.type !== "ok") {
    log("progress", `Herdr opened no progress popup for ${key}`);
    return false;
  }

  log("progress", `watching ${key} in a ${POPUP_COLUMNS}x${POPUP_ROWS} popup`);
  return true;
}
