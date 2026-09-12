/**
 * Turning "which worktree is this about?" into a path.
 *
 * Event hooks carry one, so they parse `HERDR_PLUGIN_EVENT_JSON` directly.
 * Actions and panes carry a `PluginInvocationContext` instead, which is usually
 * enough — but a popup opened from a workspace Herdr restored before this plugin
 * existed has neither a context worktree nor a record, so the resolution chain
 * ends at `herdr api snapshot`.
 */
import { existsSync } from "node:fs";
import { herdrBin } from "./paths.ts";
import { findByWorkspace, readState } from "./state.ts";

export type WorktreeEventKind = "created" | "removed";

export type WorktreeEvent = {
  kind: WorktreeEventKind;
  path: string;
  branch: string | null;
  label: string | null;
  workspaceId: string | null;
  repoKey: string | null;
  repoRoot: string | null;
};

/** The same event arrives underscored in `data.type` and dotted in `event`. */
const WORKTREE_KINDS: Record<string, WorktreeEventKind> = {
  worktree_created: "created",
  worktree_removed: "removed",
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asObject(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** `{event, data}` — the EventEnvelope shape Herdr hands to event hooks. */
export function envelope(rawJson: string | undefined): { event?: string; data?: Record<string, unknown> } {
  const parsed = parseJsonObject(rawJson);
  if (!parsed) return {};
  const result: { event?: string; data?: Record<string, unknown> } = {};
  const event = asString(parsed.event);
  if (event) result.event = event;
  const data = asObject(parsed.data);
  if (data) result.data = data;
  return result;
}

/**
 * `null` for anything that is not a worktree creation or removal. An event that
 * carries a path but no recognisable kind is rejected: the caller cannot tell
 * teardown from startup, and guessing wrong either leaves a stack running or
 * starts one for a checkout that is already gone.
 */
export function parseWorktreeEvent(rawJson: string | undefined): WorktreeEvent | null {
  const env = envelope(rawJson);
  const data = env.data ?? {};

  const kind = [asString(data.type), asString(env.event)]
    .map((name) => (name === null ? null : WORKTREE_KINDS[name.replaceAll(".", "_")]))
    .find((candidate) => candidate !== null && candidate !== undefined);
  if (kind === undefined || kind === null) return null;

  const worktree = asObject(data.worktree);
  const workspace = asObject(data.workspace);
  const path = asString(worktree?.path) ?? asString(worktree?.checkout_path) ?? asString(data.path);
  if (!path || !path.startsWith("/")) return null;

  const workspaceWorktree = asObject(workspace?.worktree);
  return {
    kind,
    path,
    branch: asString(worktree?.branch),
    label: asString(worktree?.label) ?? asString(workspace?.label),
    workspaceId: asString(workspace?.workspace_id) ?? asString(data.workspace_id),
    repoKey: asString(workspaceWorktree?.repo_key) ?? asString(worktree?.repo_key),
    repoRoot: asString(workspaceWorktree?.repo_root),
  };
}

/** The `PluginInvocationContext` object Herdr passes to actions and panes. */
export function contextJson(): Record<string, unknown> {
  return parseJsonObject(process.env.HERDR_PLUGIN_CONTEXT_JSON) ?? {};
}

export function snapshotWorktreePath(workspaceId: string): string | null {
  const proc = Bun.spawnSync([herdrBin(), "api", "snapshot"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return null;

  try {
    const response = asObject(JSON.parse(proc.stdout.toString()) as unknown);
    const snapshot = asObject(asObject(response?.result)?.snapshot);
    const workspaces = snapshot?.workspaces;
    if (!Array.isArray(workspaces)) return null;
    for (const entry of workspaces) {
      const workspace = asObject(entry);
      if (asString(workspace?.workspace_id) !== workspaceId) continue;
      return asString(asObject(workspace?.worktree)?.checkout_path);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * For actions and panes. Steps 1–3 must exist on disk (a stale context path is
 * worse than no answer); step 4 is the plugin's own record, step 5 asks Herdr.
 * The `source` label is printed by the popup so a wrong pick is diagnosable.
 */
export function resolveWorktreePath(): { path: string; source: string } | null {
  const ctx = contextJson();
  const fromContext: Array<[string, string | null]> = [
    ["context.worktree", asString(asObject(ctx.worktree)?.checkout_path)],
    ["context.workspace_cwd", asString(ctx.workspace_cwd)],
    ["context.pane_cwd", asString(ctx.focused_pane_cwd)],
  ];
  for (const [source, candidate] of fromContext) {
    if (candidate && existsSync(candidate)) return { path: candidate, source };
  }

  const workspaceId = asString(ctx.workspace_id) ?? asString(process.env.HERDR_WORKSPACE_ID);
  if (!workspaceId) return null;

  const recorded = findByWorkspace(readState(), workspaceId);
  if (recorded) return { path: recorded.path, source: "state" };

  const fromSnapshot = snapshotWorktreePath(workspaceId);
  if (fromSnapshot && existsSync(fromSnapshot)) return { path: fromSnapshot, source: "snapshot" };

  return null;
}
