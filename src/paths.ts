/**
 * Every path the plugin reads or writes, resolved from the environment Herdr
 * sets for plugin commands. Nothing here guesses a fallback directory for
 * state or config: a missing `HERDR_PLUGIN_STATE_DIR`/`HERDR_PLUGIN_CONFIG_DIR`
 * is a bug in the caller, not something to paper over with a temp dir.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function pluginRoot(): string {
  const fromEnv = process.env.HERDR_PLUGIN_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return dirname(import.meta.dir);
}

export function stateDir(): string {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir || dir.length === 0) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configDir(): string {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir || dir.length === 0) throw new Error("HERDR_PLUGIN_CONFIG_DIR is not set");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(): string {
  return join(stateDir(), "state.json");
}

export function stateLockPath(): string {
  return join(stateDir(), "state.lock");
}

export function logPath(key: string): string {
  return join(stateDir(), "logs", `${key}.log`);
}

export function runLockPath(key: string): string {
  return join(stateDir(), "runs", `${key}.lock`);
}

export function pluginLogPath(): string {
  return join(stateDir(), "plugin.log");
}

export function lastEventPath(): string {
  return join(stateDir(), "last-event.json");
}

/** Herdr's own executable, as Herdr told us it is invoked. */
export function herdrBin(): string {
  const fromEnv = process.env.HERDR_BIN_PATH;
  return fromEnv && fromEnv.length > 0 ? fromEnv : "herdr";
}
