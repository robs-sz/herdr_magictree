import { describe, expect, test } from "bun:test";
import { parseWorktreeEvent } from "../src/worktree-path.ts";

const FULL = JSON.stringify({
  event: "worktree.created",
  data: {
    type: "worktree_created",
    worktree: { path: "/tmp/wt", branch: "feat/x", label: "feat/x" },
    workspace: { workspace_id: "w7", label: "feat/x", worktree: { repo_key: "abc" } },
  },
});

const REMOVED = JSON.stringify({
  event: "worktree_removed",
  data: {
    type: "worktree_removed",
    workspace_id: "w7",
    workspace: {
      workspace_id: "w7",
      label: "wt",
      worktree: { repo_key: "/repo/.git", repo_root: "/repo", checkout_path: "/tmp/wt" },
    },
    worktree: { path: "/tmp/wt", branch: "feat/x", label: "repo" },
    forced: true,
  },
});

describe("parseWorktreeEvent", () => {
  test("a worktree.created envelope yields every field", () => {
    expect(parseWorktreeEvent(FULL)).toEqual({
      kind: "created",
      path: "/tmp/wt",
      branch: "feat/x",
      label: "feat/x",
      workspaceId: "w7",
      repoKey: "abc",
      repoRoot: null,
    });
  });

  test("a worktree.removed envelope carries the repository root", () => {
    expect(parseWorktreeEvent(REMOVED)).toEqual({
      kind: "removed",
      path: "/tmp/wt",
      branch: "feat/x",
      label: "repo",
      workspaceId: "w7",
      repoKey: "/repo/.git",
      repoRoot: "/repo",
    });
  });

  test("the event name alone is enough", () => {
    expect(parseWorktreeEvent(JSON.stringify({ event: "worktree_created", data: { worktree: { path: "/tmp/wt" } } }))).toEqual({
      kind: "created",
      path: "/tmp/wt",
      branch: null,
      label: null,
      workspaceId: null,
      repoKey: null,
      repoRoot: null,
    });
  });

  test("the dotted event name alone is enough", () => {
    expect(
      parseWorktreeEvent(JSON.stringify({ event: "worktree.removed", data: { worktree: { path: "/tmp/wt" } } }))?.kind,
    ).toBe("removed");
  });

  test("a different event is ignored", () => {
    expect(parseWorktreeEvent(JSON.stringify({ event: "pane.created", data: { type: "pane_created" } }))).toBeNull();
  });

  test("garbage and absence are ignored rather than thrown", () => {
    expect(parseWorktreeEvent("not json")).toBeNull();
    expect(parseWorktreeEvent(undefined)).toBeNull();
  });

  test("a path with no event kind is rejected", () => {
    // Teardown and startup are indistinguishable without a kind, and guessing
    // wrong either leaves a stack running or starts one for a dead checkout.
    expect(parseWorktreeEvent(JSON.stringify({ data: { worktree: { checkout_path: "/tmp/wt" } } }))).toBeNull();
  });

  test("a relative path is rejected", () => {
    expect(parseWorktreeEvent(JSON.stringify({ event: "worktree.created", data: { worktree: { path: "wt" } } }))).toBeNull();
  });
});
