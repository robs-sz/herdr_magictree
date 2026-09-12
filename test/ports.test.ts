import { describe, expect, test } from "bun:test";
import { parsePorts } from "../src/magictree.ts";

const ACME = [
  "worktree main (block 22060-22079)",
  "api:api                  22062  http://localhost:22062",
  "minio                    22060  http://localhost:22060",
  "minio:minio_console      22065  http://localhost:22065",
  "",
].join("\n");

describe("parsePorts", () => {
  test("reads the real `magictree ports` table", () => {
    expect(parsePorts(ACME)).toEqual({
      services: [
        { id: "api:api", port: 22062, url: "http://localhost:22062" },
        { id: "minio", port: 22060, url: "http://localhost:22060" },
        { id: "minio:minio_console", port: 22065, url: "http://localhost:22065" },
      ],
      unparsed: [],
    });
  });

  test("an unrecognised row is reported, not fatal", () => {
    const { services, unparsed } = parsePorts(
      ["worktree main (block 22060-22079)", "weird line here", "api:api                  22062  http://localhost:22062"].join("\n"),
    );
    expect(unparsed).toEqual(["weird line here"]);
    expect(services).toEqual([{ id: "api:api", port: 22062, url: "http://localhost:22062" }]);
  });

  test("empty output yields nothing", () => {
    expect(parsePorts("")).toEqual({ services: [], unparsed: [] });
  });
});
