/**
 * `stack` action: open the status popup.
 *
 * Opening a Herdr pane needs Herdr itself, and the action's argv is run with
 * cwd at the plugin root, so the popup is launched through `$HERDR_BIN_PATH`
 * rather than by this process rendering anything.
 */
import { log } from "./log.ts";
import { herdrBin } from "./paths.ts";
import { notify } from "./start.ts";

const result = Bun.spawnSync(
  [
    herdrBin(),
    "plugin",
    "pane",
    "open",
    "--plugin",
    "magictree",
    "--entrypoint",
    "stack",
    "--placement",
    "popup",
  ],
  { stdout: "inherit", stderr: "inherit" },
);

const code = result.exitCode ?? 1;
if (code !== 0) {
  log("action", `plugin pane open exited ${code}`);
  // Always announced: the user asked for the popup, so a silent failure is worse
  // than a toast for someone who turned off automatic run notifications.
  notify(null, "Status pane failed", "see the plugin log for details");
}
process.exit(code);
