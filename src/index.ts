/**
 * Pi Watcher Extension
 *
 * M1 scaffold: register the `/watcher` command and expose config-path helpers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type WatcherAgentContext,
  WatcherRouter,
  type WatcherRouterResult,
} from "./router";
import { PiFileWatcher } from "./watcher";

export type WatcherConfigScope = "global" | "project";
export type WatcherBusyPolicy = "queue_until_idle";
export type WatcherCommand =
  | { kind: "clear" }
  | { kind: "config" }
  | { kind: "help" }
  | { kind: "retry" }
  | { kind: "scan" }
  | { kind: "status" }
  | { enabled: boolean; kind: "setEnabled"; scope: WatcherConfigScope };
export interface WatcherConfig {
  enabled?: boolean;
  scanOnStart?: boolean;
  roots?: string[];
  include?: string[];
  ignore?: string[];
  maxFileBytes?: number;
  debounceMs?: number;
  contextLines?: number;
  maxPromptBytes?: number;
  marker?: string;
  removeHandledActionComments?: boolean;
  removeContextAnchorsInActionBlock?: boolean;
  busyPolicy?: WatcherBusyPolicy;
}

export { WatcherRouter } from "./router";
export { PiFileWatcher } from "./watcher";
export { buildWatcherPrompt } from "./prompt";
export type {
  WatcherAgentContext,
  WatcherRouterResult,
  WatcherRouterSnapshot,
  WatcherRouterStatus,
} from "./router";
export {
  PI_WATCHER_STATE_ENTRY_TYPE,
  clearProcessedMarkerIds,
  completeInFlightBatch,
  createMarkerContextId,
  createMarkerIntentId,
  createWatcherState,
  filterBatchForDispatch,
  markBatchInFlight,
} from "./state";
export { parseAiMarkers } from "./parser";
export type {
  BuildWatcherPromptOptions,
  BuiltWatcherPrompt,
  WatcherFileState,
} from "./prompt";
export type {
  AiMarkerAction,
  AiMarkerBlock,
  ParsedAiMarker,
  ParseAiMarkersOptions,
} from "./parser";
export type {
  WatcherBatch,
  WatcherState,
  CompletedWatcherBatch,
} from "./state";

export type EffectiveWatcherConfig = Required<WatcherConfig>;

const DEFAULT_IGNORE: string[] = [
  "**/.git/**",
  "**/.jj/**",
  "**/.pi/**",
  "**/.agents/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.cache/**",
];

export const DEFAULT_CONFIG: EffectiveWatcherConfig = {
  enabled: true,
  scanOnStart: true,
  roots: ["."],
  include: ["**/*"],
  ignore: DEFAULT_IGNORE,
  maxFileBytes: 1_048_576,
  debounceMs: 300,
  contextLines: 12,
  maxPromptBytes: 60_000,
  marker: "AI",
  removeHandledActionComments: true,
  removeContextAnchorsInActionBlock: false,
  busyPolicy: "queue_until_idle",
};

const BOOLEAN_CONFIG_KEYS = [
  "enabled",
  "scanOnStart",
  "removeHandledActionComments",
  "removeContextAnchorsInActionBlock",
] as const;
const NUMBER_CONFIG_KEYS = [
  "maxFileBytes",
  "debounceMs",
  "contextLines",
  "maxPromptBytes",
] as const;
const STRING_ARRAY_CONFIG_KEYS = ["roots", "include", "ignore"] as const;

const VALID_SCOPES: ReadonlySet<string> = new Set(["global", "project"]);
const WATCHER_HELP = [
  "/watcher status              show watcher status",
  "/watcher config              show effective config paths and values",
  "/watcher start               enable watcher in project config",
  "/watcher stop                disable watcher in project config",
  "/watcher clear               clear pending queue + processed marker ledger",
  "/watcher retry               retry last suppressed marker batch",
  "/watcher scan                scan roots now for AI comments",
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

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function normalizeConfig(record: Record<string, unknown>): WatcherConfig {
  const config: WatcherConfig = {};

  for (const key of BOOLEAN_CONFIG_KEYS) {
    const value = record[key];
    if (typeof value === "boolean") {
      config[key] = value;
    }
  }

  for (const key of NUMBER_CONFIG_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      config[key] = value;
    }
  }

  for (const key of STRING_ARRAY_CONFIG_KEYS) {
    const value = record[key];
    if (isStringArray(value)) {
      config[key] = value;
    }
  }

  if (typeof record.marker === "string") {
    config.marker = record.marker;
  }

  if (record.busyPolicy === "queue_until_idle") {
    config.busyPolicy = record.busyPolicy;
  }

  return config;
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
    ...DEFAULT_CONFIG,
    ...normalizeConfig(globalConfig as Record<string, unknown>),
    ...normalizeConfig(projectConfig as Record<string, unknown>),
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

function setWatcherRuntimeStatus(
  ctx: {
    hasUI: boolean;
    ui: { setStatus: (key: string, text: string | undefined) => void };
  },
  enabled: boolean,
): void {
  if (!ctx.hasUI) {
    return;
  }

  ctx.ui.setStatus("pi-watcher", `watcher ${enabled ? "on" : "off"}`);
}

export function parseWatcherArgs(args: string): WatcherCommand {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (parts.length === 0 || (parts.length === 1 && parts[0] === "status")) {
    return { kind: "status" };
  }

  if (parts.length === 1 && parts[0] === "config") {
    return { kind: "config" };
  }

  if (
    parts.length === 1 &&
    (parts[0] === "clear" || parts[0] === "retry" || parts[0] === "scan")
  ) {
    return { kind: parts[0] as "clear" | "retry" | "scan" };
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

export function formatWatcherStatus(
  cwd: string,
  runtimeEnabled?: boolean,
): string {
  const globalPath = getGlobalConfigPath().path;
  const projectPath = getProjectConfigPath(cwd).path;
  const config = loadEffectiveConfig(cwd);
  const state = config.enabled ? "enabled" : "disabled";
  const runtimeState = runtimeEnabled ?? config.enabled;

  return [
    `pi-watcher: ${state}`,
    `cwd: ${cwd}`,
    `global config: ${globalPath}`,
    `project config: ${projectPath}`,
    `runtime: watcher ${runtimeState ? "on" : "off"}`,
  ].join("\n");
}

function formatRouterResult(
  action: "retry",
  result: WatcherRouterResult,
): string {
  switch (result.status) {
    case "dispatched":
      return `pi-watcher ${action}: dispatched last marker batch`;
    case "queued":
      return `pi-watcher ${action}: queued last marker batch until pi is idle`;
    case "suppressed":
      return `pi-watcher ${action}: nothing to retry`;
    case "completed":
      return `pi-watcher ${action}: no pending work`;
  }
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

function publishWarning(
  ctx: {
    hasUI: boolean;
    ui: {
      notify: (message: string, level?: "error" | "info" | "warning") => void;
    };
  },
  message: string,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
    return;
  }

  console.warn(message);
}

type WatcherExtensionContext = WatcherAgentContext & {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, level?: "error" | "info" | "warning") => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
};

export default function piWatcherExtension(pi: ExtensionAPI): void {
  const router = new WatcherRouter(pi);
  let runtimeEnabled = false;
  let fileWatcher: PiFileWatcher | null = null;

  function createRuntimeWatcher(
    ctx: WatcherExtensionContext,
    effectiveConfig: EffectiveWatcherConfig,
  ): PiFileWatcher {
    return new PiFileWatcher({
      cwd: ctx.cwd,
      debounceMs: effectiveConfig.debounceMs,
      ignore: effectiveConfig.ignore,
      include: effectiveConfig.include,
      marker: effectiveConfig.marker,
      maxFileBytes: effectiveConfig.maxFileBytes,
      onBatch: (batch) => {
        router.enqueueBatch(batch, ctx, {
          contextLines: effectiveConfig.contextLines,
          maxPromptBytes: effectiveConfig.maxPromptBytes,
        });
      },
      onError: (error) => {
        publishWarning(ctx, `pi-watcher file watcher error: ${String(error)}`);
      },
      roots: effectiveConfig.roots,
    });
  }

  async function closeRuntimeWatcher(): Promise<void> {
    const watcher = fileWatcher;
    fileWatcher = null;

    if (watcher) {
      await watcher.close();
    }
  }

  async function startRuntimeWatcher(
    ctx: WatcherExtensionContext,
    effectiveConfig: EffectiveWatcherConfig,
    scanReason: string | null,
  ): Promise<void> {
    await closeRuntimeWatcher();
    const watcher = createRuntimeWatcher(ctx, effectiveConfig);
    fileWatcher = watcher;
    await watcher.start();

    if (fileWatcher !== watcher || watcher.isClosed()) {
      return;
    }

    runtimeEnabled = true;
    setWatcherRuntimeStatus(ctx, true);

    if (scanReason) {
      await watcher.scan(scanReason);
    }
  }

  async function applyEffectiveConfig(
    ctx: WatcherExtensionContext,
    effectiveConfig: EffectiveWatcherConfig,
  ): Promise<void> {
    try {
      if (!effectiveConfig.enabled) {
        await closeRuntimeWatcher();
        runtimeEnabled = false;
        setWatcherRuntimeStatus(ctx, false);
        return;
      }

      await startRuntimeWatcher(
        ctx,
        effectiveConfig,
        effectiveConfig.scanOnStart ? "startup_scan" : null,
      );
    } catch (error) {
      await closeRuntimeWatcher();
      runtimeEnabled = false;
      setWatcherRuntimeStatus(ctx, false);
      publishWarning(ctx, `Failed to start pi-watcher: ${String(error)}`);
    }
  }

  async function scanRuntimeWatcher(
    ctx: WatcherExtensionContext,
    effectiveConfig: EffectiveWatcherConfig,
  ): Promise<boolean> {
    const watcher = fileWatcher ?? createRuntimeWatcher(ctx, effectiveConfig);
    const batch = await watcher.scan("manual_scan");

    if (!fileWatcher) {
      await watcher.close();
    }

    return batch !== null;
  }

  pi.on("session_start", async (_event, ctx) => {
    await applyEffectiveConfig(ctx, loadEffectiveConfig(ctx.cwd));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await closeRuntimeWatcher();
    runtimeEnabled = false;
    setWatcherRuntimeStatus(ctx, runtimeEnabled);
  });

  pi.on("agent_end", async (_event, ctx) => {
    router.handleAgentEnd(ctx);
  });

  pi.registerCommand("watcher", {
    description: "Control pi-watcher editor-comment watch mode",
    getArgumentCompletions: (prefix: string) => {
      const completions = [
        "status",
        "config",
        "start",
        "stop",
        "clear",
        "retry",
        "scan",
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

      if (command.kind === "clear") {
        router.clear();
        publishMessage(
          ctx,
          "pi-watcher queue and processed marker ledger cleared",
        );
        return;
      }

      if (command.kind === "retry") {
        const effectiveConfig = loadEffectiveConfig(ctx.cwd);
        const result = router.retryLast(ctx, {
          contextLines: effectiveConfig.contextLines,
          maxPromptBytes: effectiveConfig.maxPromptBytes,
        });
        publishMessage(ctx, formatRouterResult("retry", result));
        return;
      }

      if (command.kind === "scan") {
        const didDispatch = await scanRuntimeWatcher(
          ctx,
          loadEffectiveConfig(ctx.cwd),
        );
        publishMessage(
          ctx,
          didDispatch
            ? "pi-watcher scan: actionable markers dispatched or queued"
            : "pi-watcher scan: no actionable markers found",
        );
        return;
      }

      if (command.kind === "setEnabled") {
        const configPath = getConfigPathForScope(command.scope, ctx.cwd);
        const saveError = saveConfigToPath(configPath.path, {
          enabled: command.enabled,
        });

        if (saveError) {
          publishWarning(
            ctx,
            `Failed to save pi-watcher ${command.scope} config: ${saveError}`,
          );
          return;
        }

        const effectiveConfig = loadEffectiveConfig(ctx.cwd);
        await applyEffectiveConfig(ctx, effectiveConfig);

        publishMessage(
          ctx,
          `pi-watcher ${command.scope} config set to enabled=${command.enabled}`,
        );
        return;
      }

      publishMessage(ctx, formatWatcherStatus(ctx.cwd, runtimeEnabled));
    },
  });
}
