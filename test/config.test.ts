import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, configPath, DEFAULT_CONFIG, ensureConfigFile, loadConfig } from "../src/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mth-config-"));
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
});

function writeConfig(toml: string): void {
  writeFileSync(configPath(), toml);
}

describe("loadConfig", () => {
  test("a missing file yields defaults and ensureConfigFile writes the documented file", () => {
    expect(ensureConfigFile()).toBe(configPath());
    const { config, warnings } = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
    expect(readFileSync(configPath(), "utf8")).toContain('magictree_bin = "magictree"');
  });

  test("an out-of-range missing_manifest names both allowed values", () => {
    writeConfig('missing_manifest = "nope"\n');
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/missing_manifest must be "notify" or "skip", got "nope"/);
  });

  test("args are read as an argv array", () => {
    writeConfig('args = ["--app", "web"]\n');
    expect(loadConfig().config.args).toEqual(["--app", "web"]);
  });

  test("an unknown key warns without failing the load", () => {
    writeConfig('argz = ["--app"]\nmissing_manifest = "skip"\n');
    const { config, warnings } = loadConfig();
    expect(config.missingManifest).toBe("skip");
    expect(warnings).toEqual(['unknown config key "argz" (ignored)']);
  });

  test("a zero timeout is rejected", () => {
    writeConfig("up_timeout_secs = 0\n");
    expect(() => loadConfig()).toThrow(/up_timeout_secs must be an integer >= 1, got 0/);
  });

  test("malformed TOML reports the config path", () => {
    writeConfig("enabled = \n");
    expect(() => loadConfig()).toThrow(new RegExp(`cannot read ${configPath()}`));
  });
});
