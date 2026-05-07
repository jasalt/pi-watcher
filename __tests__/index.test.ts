import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  formatWatcherStatus,
  getProjectConfigPath,
  parseWatcherArgs,
  resolveEffectiveConfig,
} from "../src/index";

describe("pi-watcher scaffold", () => {
  it("stores project config under cwd .pi/extensions", () => {
    expect(getProjectConfigPath("/repo")).toEqual({
      dir: "/repo/.pi/extensions",
      path: "/repo/.pi/extensions/pi-watcher.json",
    });
  });

  it("defaults watcher config to enabled", () => {
    expect(DEFAULT_CONFIG).toEqual({ enabled: true });
    expect(resolveEffectiveConfig()).toEqual({ enabled: true });
  });

  it("merges config with project taking precedence", () => {
    expect(
      resolveEffectiveConfig({ enabled: false }, { enabled: true }),
    ).toEqual({
      enabled: true,
    });
  });

  it("treats bare start and stop commands as project scoped", () => {
    expect(parseWatcherArgs("start")).toEqual({
      enabled: true,
      kind: "setEnabled",
      scope: "project",
    });
    expect(parseWatcherArgs("stop")).toEqual({
      enabled: false,
      kind: "setEnabled",
      scope: "project",
    });
  });

  it("formats status output for the watcher command", () => {
    expect(formatWatcherStatus("/repo")).toContain("pi-watcher: enabled");
    expect(formatWatcherStatus("/repo")).toContain(
      "project config: /repo/.pi/extensions/pi-watcher.json",
    );
  });
});
