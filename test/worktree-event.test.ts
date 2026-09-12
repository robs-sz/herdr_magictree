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

describe("parseWorktreeEvent", () => {
  test("a worktree.created envelope yields every field", () => {
    expect(parseWorktreeEvent(FULL)).toEqual({
      path: "/tmp/wt",
      branch: "feat/x",
      label: "feat/x",
      workspaceId: "w7",
      repoKey: "abc",
    });
  });

  test("the event name alone is enough", () => {
    expect(parseWorktreeEvent(JSON.stringify({ event: "worktree_created", data: { worktree: { path: "/tmp/wt" } } }))).toEqual({
      path: "/tmp/wt",
      branch: null,
      label: null,
      workspaceId: null,
      repoKey: null,
    });
  });

  test("the data type alone is enough", () => {
    expect(
      parseWorktreeEvent(JSON.stringify({ event: "worktree.created", data: { worktree: { path: "/tmp/wt" } } })),
    ).toEqual({ path: "/tmp/wt", branch: null, label: null, workspaceId: null, repoKey: null });
  });

  test("a different event is ignored", () => {
    expect(parseWorktreeEvent(JSON.stringify({ event: "pane.created", data: { type: "pane_created" } }))).toBeNull();
  });

  test("garbage and absence are ignored rather than thrown", () => {
    expect(parseWorktreeEvent("not json")).toBeNull();
    expect(parseWorktreeEvent(undefined)).toBeNull();
  });

  test("a checkout_path-only payload still resolves a path", () => {
    expect(
      parseWorktreeEvent(JSON.stringify({ data: { worktree: { checkout_path: "/tmp/wt" } } })),
    ).toEqual({ path: "/tmp/wt", branch: null, label: null, workspaceId: null, repoKey: null });
  });

  test("a relative path is rejected", () => {
    expect(parseWorktreeEvent(JSON.stringify({ event: "worktree.created", data: { worktree: { path: "wt" } } }))).toBeNull();
  });
});
