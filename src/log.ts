/**
 * The plugin's single log sink. Herdr keeps plugin command stdout in its own
 * log, but that scrolls away and is per-invocation; this file is the durable
 * trail a user reads when a stack fails to start. Logging must never be the
 * reason a hook or a run dies, so every failure here is swallowed.
 *
 * `capLine` and `elapsedText` live here too: they are the one-line shapes the
 * toasts, run records and the progress pane all have to agree on.
 */
import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import { pluginLogPath } from "./paths.ts";

function appendLine(line: string): void {
  try {
    appendFileSync(pluginLogPath(), `${line}\n`);
  } catch {
    // Unwritable state dir (or unset HERDR_PLUGIN_STATE_DIR): stdout is all we get.
  }
}

export function log(scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] ${scope} ${message}`;
  process.stdout.write(`${line}\n`);
  appendLine(line);
}

/** Durable trail without stdout for commands whose output is the pane UI. */
export function logQuiet(scope: string, message: string): void {
  appendLine(`[${new Date().toISOString()}] ${scope} ${message}`);
}

const LOG_TAIL_BYTES = 4096;

/** Read the last non-empty log line without loading the full transcript. */
export function lastLogLine(path: string, cap = 120): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const from = Math.max(0, size - LOG_TAIL_BYTES);
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line.length > 0) return capLine(line, cap);
    }
  } catch {
    // No log yet, or it is mid-write.
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return "";
}

/** First `cap` characters, cut with `...` — the one-liner shape toasts and records share. */
export function capLine(line: string, cap = 120): string {
  return line.length > cap ? `${line.slice(0, cap - 3)}...` : line;
}

/** `12s`, `2m`, `1m05s` — how long a run has been going, on a toast or in the pane. */
export function elapsedText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
