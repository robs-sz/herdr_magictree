/**
 * The plugin's single log sink. Herdr keeps plugin command stdout in its own
 * log, but that scrolls away and is per-invocation; this file is the durable
 * trail a user reads when a stack fails to start. Logging must never be the
 * reason a hook or a run dies, so every failure here is swallowed.
 */
import { appendFileSync } from "node:fs";
import { pluginLogPath } from "./paths.ts";

export function log(scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] ${scope} ${message}`;
  process.stdout.write(`${line}\n`);
  try {
    appendFileSync(pluginLogPath(), `${line}\n`);
  } catch {
    // Unwritable state dir (or unset HERDR_PLUGIN_STATE_DIR): stdout is all we get.
  }
}

/** First `cap` characters, cut with `...` — the one-liner shape toasts and records share. */
export function capLine(line: string, cap = 120): string {
  return line.length > cap ? `${line.slice(0, cap - 3)}...` : line;
}
