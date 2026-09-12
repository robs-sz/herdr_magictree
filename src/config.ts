/**
 * User-facing configuration: a commented TOML file the user owns.
 *
 * Loading is deliberately total in the sense that matters — a bad value raises
 * `ConfigError` (never a silent fallback), and every caller turns that into a
 * notification plus a log line instead of a crash. Unknown keys warn so a typo
 * (`argz`) shows up in `plugin.log` and the popup rather than silently doing
 * nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { configDir } from "./paths.ts";

export type MissingManifestMode = "notify" | "skip";

export type Config = {
  enabled: boolean;
  onWorktreeCreated: boolean;
  missingManifest: MissingManifestMode;
  args: string[];
  upTimeoutSecs: number;
  notify: boolean;
  magictreeBin: string;
};

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  onWorktreeCreated: true,
  missingManifest: "notify",
  args: [],
  upTimeoutSecs: 1800,
  notify: true,
  magictreeBin: "magictree",
};

export const DEFAULT_CONFIG_TOML = `# Herdr plugin "magictree" — https://github.com/<owner>/herdr_magictree
# Restart-free: read on every hook, action, and popup invocation.

# Master switch for the automatic hook. Manual actions still work when false.
enabled = true

# Run when Herdr creates a new worktree.
on_worktree_created = true

# Behavior when the worktree's repository has no magictree.toml:
#   "notify" - record the worktree and report the commands to run (default)
#   "skip"   - record nothing about it
missing_manifest = "notify"

# Extra argv appended to \`magictree up\`, e.g. ["--app", "web"] or ["--all"].
args = []

# Kill a run that exceeds this many seconds.
up_timeout_secs = 1800

# Show a Herdr notification when a run starts, succeeds, or fails.
notify = true

# magictree executable. Absolute path or a name resolved on PATH.
magictree_bin = "magictree"
`;

export class ConfigError extends Error {}

export type LoadedConfig = { config: Config; path: string; warnings: string[] };

export function configPath(): string {
  return join(configDir(), "config.toml");
}

/** Writes the commented default file on first use; never overwrites. */
export function ensureConfigFile(): string {
  const path = configPath();
  if (!existsSync(path)) writeFileSync(path, DEFAULT_CONFIG_TOML);
  return path;
}

const KNOWN_KEYS: Record<string, true> = {
  enabled: true,
  on_worktree_created: true,
  missing_manifest: true,
  args: true,
  up_timeout_secs: true,
  notify: true,
  magictree_bin: true,
};

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function loadConfig(): LoadedConfig {
  const path = ensureConfigFile();
  let raw: Record<string, unknown>;
  try {
    raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }

  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(KNOWN_KEYS, key)) warnings.push(`unknown config key "${key}" (ignored)`);
  }

  const missingManifestRaw = raw.missing_manifest;
  if (
    missingManifestRaw !== undefined &&
    missingManifestRaw !== "notify" &&
    missingManifestRaw !== "skip"
  ) {
    throw new ConfigError(
      `missing_manifest must be "notify" or "skip", got ${JSON.stringify(missingManifestRaw)}`,
    );
  }

  const argsRaw = raw.args;
  if (argsRaw !== undefined && (!Array.isArray(argsRaw) || argsRaw.some((a) => typeof a !== "string"))) {
    throw new ConfigError(`args must be an array of strings, got ${JSON.stringify(argsRaw)}`);
  }

  const timeoutRaw = raw.up_timeout_secs;
  if (
    timeoutRaw !== undefined &&
    (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 1)
  ) {
    throw new ConfigError(`up_timeout_secs must be an integer >= 1, got ${JSON.stringify(timeoutRaw)}`);
  }

  const binRaw = raw.magictree_bin;
  if (binRaw !== undefined && (typeof binRaw !== "string" || binRaw.trim().length === 0)) {
    throw new ConfigError(`magictree_bin must be a non-empty string, got ${JSON.stringify(binRaw)}`);
  }

  const config: Config = {
    enabled: readBoolean(raw, "enabled", DEFAULT_CONFIG.enabled),
    onWorktreeCreated: readBoolean(raw, "on_worktree_created", DEFAULT_CONFIG.onWorktreeCreated),
    missingManifest: (missingManifestRaw as MissingManifestMode | undefined) ?? DEFAULT_CONFIG.missingManifest,
    args: (argsRaw as string[] | undefined) ?? [...DEFAULT_CONFIG.args],
    upTimeoutSecs: (timeoutRaw as number | undefined) ?? DEFAULT_CONFIG.upTimeoutSecs,
    notify: readBoolean(raw, "notify", DEFAULT_CONFIG.notify),
    magictreeBin: (binRaw as string | undefined) ?? DEFAULT_CONFIG.magictreeBin,
  };

  return { config, path, warnings };
}
