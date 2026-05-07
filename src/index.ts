/**
 * Pi Watcher Extension
 *
 * M1 scaffold: register the `/watcher` command and expose config-path helpers.
 * Later milestones add auto-start, parser, router, and chokidar integration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type WatcherConfigScope = "global" | "project";
export type WatcherCommand =
  | { kind: "config" }
  | { kind: "help" }
  | { kind: "status" }
  | { enabled: boolean; kind: "setEnabled"; scope: WatcherConfigScope };

export interface WatcherConfig {
  enabled?: boolean;
}

export interface EffectiveWatcherConfig {
  enabled: boolean;
}

export const DEFAULT_CONFIG: EffectiveWatcherConfig = {
  enabled: true,
};

const VALID_SCOPES: ReadonlySet<string> = new Set(["global", "project"]);
const WATCHER_HELP = [
  "/watcher status              show watcher status",
  "/watcher config              show effective config paths and values",
  "/watcher start               enable watcher in project config",
  "/watcher stop                disable watcher in project config",
  "/watcher global start|stop   update global config",
  "/watcher project start|stop  update project config",
].join("\n");

export function getGlobalConfigPath(): { dir: string; path: string } {
  const dir = join(homedir(), ".pi", "agent");
  return { dir, path: join(dir, "pi-watcher.json") };
}

export function getProjectConfigPath(cwd: string): {
  dir: string;
  path: string;
} {
  const dir = join(cwd, ".pi", "extensions");
  return { dir, path: join(dir, "pi-watcher.json") };
}

function normalizeConfig(record: Record<string, unknown>): WatcherConfig {
  if (typeof record.enabled === "boolean") {
    return { enabled: record.enabled };
  }

  return {};
}

export function loadConfigFromPath(configPath: string): WatcherConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    return normalizeConfig(parsed as Record<string, unknown>);
  } catch (error) {
    console.error(
      `[pi-watcher] Failed to load config from ${configPath}: ${String(error)}`,
    );
    return {};
  }
}

export function resolveEffectiveConfig(
  globalConfig: WatcherConfig = {},
  projectConfig: WatcherConfig = {},
): EffectiveWatcherConfig {
  return {
    enabled:
      projectConfig.enabled ?? globalConfig.enabled ?? DEFAULT_CONFIG.enabled,
  };
}

function getConfigPathForScope(
  scope: WatcherConfigScope,
  cwd: string,
): { dir: string; path: string } {
  return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

function saveConfigToPath(
  configPath: string,
  config: WatcherConfig,
): string | null {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return null;
  } catch (error) {
    return String(error);
  }
}

export function parseWatcherArgs(args: string): WatcherCommand {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (parts.length === 0 || (parts.length === 1 && parts[0] === "status")) {
    return { kind: "status" };
  }

  if (parts.length === 1 && parts[0] === "config") {
    return { kind: "config" };
  }

  if (parts.length === 1 && (parts[0] === "start" || parts[0] === "stop")) {
    return {
      enabled: parts[0] === "start",
      kind: "setEnabled",
      scope: "project",
    };
  }

  if (
    parts.length === 2 &&
    VALID_SCOPES.has(parts[0]) &&
    (parts[1] === "start" || parts[1] === "stop")
  ) {
    return {
      enabled: parts[1] === "start",
      kind: "setEnabled",
      scope: parts[0] as WatcherConfigScope,
    };
  }

  return { kind: "help" };
}

function loadEffectiveConfig(cwd: string): EffectiveWatcherConfig {
  return resolveEffectiveConfig(
    loadConfigFromPath(getGlobalConfigPath().path),
    loadConfigFromPath(getProjectConfigPath(cwd).path),
  );
}

export function formatWatcherStatus(cwd: string): string {
  const globalPath = getGlobalConfigPath().path;
  const projectPath = getProjectConfigPath(cwd).path;
  const config = loadEffectiveConfig(cwd);
  const state = config.enabled ? "enabled" : "disabled";

  return [
    `pi-watcher: ${state}`,
    `cwd: ${cwd}`,
    `global config: ${globalPath}`,
    `project config: ${projectPath}`,
    "runtime: scaffold-only; file watching lands in M6",
  ].join("\n");
}

function publishMessage(
  ctx: {
    hasUI: boolean;
    ui: {
      notify: (message: string, level?: "error" | "info" | "warning") => void;
    };
  },
  message: string,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "info");
    return;
  }

  console.log(message);
}

export default function piWatcherExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-watcher", "watcher scaffold");
    }
  });

  pi.registerCommand("watcher", {
    description: "Control pi-watcher editor-comment watch mode",
    getArgumentCompletions: (prefix: string) => {
      const completions = [
        "status",
        "config",
        "start",
        "stop",
        "global start",
        "global stop",
        "project start",
        "project stop",
      ]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ label: value, value }));

      return completions.length > 0 ? completions : null;
    },
    handler: async (args, ctx) => {
      const command = parseWatcherArgs(args);

      if (command.kind === "help") {
        publishMessage(ctx, WATCHER_HELP);
        return;
      }

      if (command.kind === "setEnabled") {
        const configPath = getConfigPathForScope(command.scope, ctx.cwd);
        const saveError = saveConfigToPath(configPath.path, {
          enabled: command.enabled,
        });

        if (saveError) {
          ctx.ui.notify(
            `Failed to save pi-watcher ${command.scope} config: ${saveError}`,
            "warning",
          );
          return;
        }

        publishMessage(
          ctx,
          `pi-watcher ${command.scope} config set to enabled=${command.enabled}`,
        );
        return;
      }

      publishMessage(ctx, formatWatcherStatus(ctx.cwd));
    },
  });
}
