import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { renderCommand, upCommand } from "../src/magictree.ts";
import { missingManifestCommands } from "../src/start.ts";

const cfg: Config = { ...DEFAULT_CONFIG, args: ["--app", "web"] };

describe("command construction", () => {
  test("up appends configured args before the explicit cwd", () => {
    expect(upCommand(cfg, "/wt")).toEqual(["magictree", "up", "--app", "web", "--cwd", "/wt"]);
  });

  test("the not-onboarded instructions quote a path with a space", () => {
    const commands = missingManifestCommands("/wt/x y");
    expect(commands).toContain("cd '/wt/x y'");
    expect(commands).toContain("magictree discover");
    expect(commands).toContain("magictree init");
    expect(commands.split("\n")).toHaveLength(3);
  });

  test("renderCommand quotes only what needs it", () => {
    expect(renderCommand(["magictree", "up", "--cwd", "/wt/x y"])).toBe("magictree up --cwd '/wt/x y'");
  });
});
