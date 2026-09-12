/**
 * Everything that knows the magictree CLI: its argv, where the binary is, and
 * how to read the two facts we need out of Git.
 *
 * argv arrays (never shell strings) are the reason `--cwd` is always explicit:
 * the plugin may be invoked from a popup whose cwd is anything at all, and the
 * worktree path is the only directory that matters.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Service } from "./state.ts";

export function upCommand(cfg: Config, worktreePath: string): string[] {
  return [cfg.magictreeBin, "up", ...cfg.args, "--cwd", worktreePath];
}

export function portsCommand(cfg: Config, worktreePath: string): string[] {
  return [cfg.magictreeBin, "ports", "--cwd", worktreePath];
}

export function statusCommand(cfg: Config, worktreePath: string): string[] {
  return [cfg.magictreeBin, "status", "--cwd", worktreePath];
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Shell-quoted rendering, for log lines and the popup (never for execution). */
export function renderCommand(argv: string[]): string {
  return argv
    .map((arg) => (arg.length > 0 && SAFE_ARG.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}

/** Absolute path, or a bare name resolved on `PATH`. */
export function resolveBin(cfg: Config): string | null {
  if (cfg.magictreeBin.includes("/")) {
    try {
      accessSync(cfg.magictreeBin, constants.X_OK);
      return cfg.magictreeBin;
    } catch {
      return null;
    }
  }
  return Bun.which(cfg.magictreeBin);
}

function git(worktreePath: string, args: string[]): string | null {
  const proc = Bun.spawnSync(["git", "-C", worktreePath, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return null;
  const out = proc.stdout.toString().trim();
  return out.length > 0 ? out : null;
}

export function repoRoot(worktreePath: string): string | null {
  return git(worktreePath, ["rev-parse", "--show-toplevel"]);
}

/** The checkout is usable: it exists and Git accepts it. */
export function isWorktreeReady(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  return git(worktreePath, ["rev-parse", "--is-inside-work-tree"]) !== null;
}

export function manifestPath(root: string): string {
  return join(root, "magictree.toml");
}

export function onboarded(worktreePath: string): boolean {
  const root = repoRoot(worktreePath);
  return root !== null && existsSync(manifestPath(root));
}

/**
 * `magictree ports` renders a header line then `<id>  <port>  <url>` rows padded
 * with runs of spaces. Rows that do not fit are returned as `unparsed` for the
 * caller to log: magictree growing a column should cost us services, not the run.
 */
export function parsePorts(stdout: string): { services: Service[]; unparsed: string[] } {
  const services: Service[] = [];
  const unparsed: string[] = [];

  for (const raw of stdout.split("\n").slice(1)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const fields = line.split(/\s{2,}/);
    const port = fields.length === 3 ? Number.parseInt(fields[1]!.trim(), 10) : Number.NaN;
    if (fields.length === 3 && Number.isInteger(port)) {
      services.push({ id: fields[0]!.trim(), port, url: fields[2]!.trim() });
    } else {
      unparsed.push(line);
    }
  }

  return { services, unparsed };
}
