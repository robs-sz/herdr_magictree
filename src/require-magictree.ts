/**
 * Build step, not a runtime entrypoint. `herdr plugin install` runs every
 * `[[build]]` command before it registers the plugin, and a non-zero exit
 * aborts the install — the only way a v1 manifest can require an external
 * binary, since the manifest has no dependency field.
 *
 * Build commands run without the plugin's runtime environment, so there is no
 * `HERDR_PLUGIN_CONFIG_DIR` here and no `magictree_bin` to read: this checks
 * the default name on `PATH`, which is what the README requires of an install.
 */
import { DEFAULT_CONFIG } from "./config.ts";
import { resolveBin } from "./magictree.ts";

const resolved = resolveBin(DEFAULT_CONFIG);

if (resolved === null) {
  process.stderr.write(
    [
      `${DEFAULT_CONFIG.magictreeBin} not found on PATH.`,
      "",
      "This plugin shells out to the magictree CLI, and `herdr plugin install` refuses to",
      "register it without one. Put magictree on PATH and install again.",
      "",
      "The `magictree_bin` config key overrides the binary at runtime only: build commands",
      "run without the plugin's config directory, so it cannot satisfy this check.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

process.stdout.write(`${DEFAULT_CONFIG.magictreeBin} found at ${resolved}\n`);
