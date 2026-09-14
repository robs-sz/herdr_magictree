/**
 * The status popup, and the entrypoint a future TUI will grow from.
 *
 * Rendering is a pure function of the state file, the config, and one live
 * `magictree status` call, which is why `--print` works without a TTY: the same
 * text is available to a test, a log, or a pipe. Nothing here writes.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { configPath, loadConfig, type Config } from "./config.ts";
import { onboarded, renderCommand, statusCommand, upCommand } from "./magictree.ts";
import { pluginLogPath } from "./paths.ts";
import { missingManifestCommands } from "./start.ts";
import { findByWorkspace, readState, runKey, type WorktreeRecord } from "./state.ts";
import { resolveWorktreePath } from "./worktree-path.ts";

const LOG_TAIL_LINES = 15;
const SERVICE_SAMPLE = 5;

function relTime(at: number | null): string {
  if (at === null) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function tailLines(path: string, count: number): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-count);
  } catch {
    return [`(unreadable: ${path})`];
  }
}

/** `gone (<path>)` is the only honest status for a deleted checkout. */
function statusLine(record: WorktreeRecord): string {
  if (!existsSync(record.path)) return `gone (${record.path})`;
  const pid = record.pid === null ? "-" : String(record.pid);
  return `${record.status}  pid ${pid}  started ${relTime(record.started_at_ms)}  finished ${relTime(record.finished_at_ms)}`;
}

function serviceLine(record: WorktreeRecord | undefined): string {
  if (!record || record.services.length === 0) return "-";
  const sample = record.services
    .slice(0, SERVICE_SAMPLE)
    .map((service) => `${service.id}=${service.url}`)
    .join(", ");
  return `${record.services.length}  ${sample}`;
}

function recordFor(path: string, workspaceId: string | null): WorktreeRecord | undefined {
  const state = readState();
  const byKey = state.worktrees[runKey(path)];
  if (byKey) return byKey;
  return workspaceId === null ? undefined : findByWorkspace(state, workspaceId);
}

function liveStatus(cfg: Config, path: string): string {
  const proc = Bun.spawnSync(statusCommand(cfg, path), { cwd: path, stdout: "pipe", stderr: "pipe" });
  const lines = ["--- magictree status ---", proc.stdout.toString().trimEnd()];
  const stderr = proc.stderr.toString().trim();
  if (stderr.length > 0) lines.push(`status failed: ${stderr.split("\n")[0]}`);
  return lines.join("\n");
}

function render(): string {
  const resolved = resolveWorktreePath();
  if (resolved === null) {
    return [
      "magictree · no worktree",
      "",
      "--- this workspace is not a Git worktree ---",
      "Create one with:",
      "  herdr worktree create --cwd <repo> --branch <name>",
    ].join("\n");
  }

  const path = resolved.path;
  const loaded = loadConfig();
  const cfg = loaded.config;
  const workspaceId = process.env.HERDR_WORKSPACE_ID ?? null;
  const record = recordFor(path, workspaceId);
  const title = record?.label ?? record?.branch ?? basename(path);
  const checkoutGone = record !== undefined && !existsSync(record.path);

  const sections = [
    [
      `magictree · ${title}`,
      `path:      ${path}            (resolved via ${resolved.source})`,
      `workspace: ${workspaceId ?? "-"}`,
      `state:     ${record ? statusLine(record) : "no record"}`,
      `services:  ${serviceLine(record)}`,
      `config:    ${configPath()}    warnings: ${loaded.warnings.length > 0 ? loaded.warnings.length : "none"}`,
      `command:   ${record?.command || renderCommand(upCommand(cfg, path))}`,
    ].join("\n"),
  ];

  if (checkoutGone) {
    sections.push(
      [`--- ${record.path} is gone ---`, "The checkout no longer exists; run `magictree gc` in the repository."].join("\n"),
    );
  } else if (!onboarded(path)) {
    sections.push(
      [`--- this repository has no magictree.toml ---`, missingManifestCommands(path)].join("\n"),
    );
  } else {
    sections.push(liveStatus(cfg, path));
  }

  // A `no_manifest`/`skipped` record has a log path but never ran, so there is
  // nothing to tail; only a genuinely unreadable file lands in the fallback.
  if (record?.log_path && existsSync(record.log_path)) {
    sections.push([`--- run log (last ${LOG_TAIL_LINES} lines) ---`, ...tailLines(record.log_path, LOG_TAIL_LINES)].join("\n"));
  }

  if (loaded.warnings.length > 0) {
    sections.push(["--- config warnings ---", ...loaded.warnings].join("\n"));
  }

  return sections.join("\n\n");
}

const interactive = !process.argv.includes("--print") && process.stdin.isTTY === true;

let body: string;
try {
  body = render();
} catch (error) {
  body = `magictree: ${(error as Error).message}\nplugin log: ${pluginLogPath()}`;
}

process.stdout.write(`${body}\n`);

if (!interactive) {
  process.exitCode = 0;
} else {
  process.stdout.write("\npress any key to close\n");
  process.stdin.setRawMode(true);
  const { promise, resolve } = Promise.withResolvers<void>();
  process.stdin.once("data", () => resolve());
  await promise;
  process.stdin.setRawMode(false);
  process.exit(0);
}
