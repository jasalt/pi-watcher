import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piWatcherExtension, {
  DEFAULT_CONFIG,
  formatWatcherStatus,
  getProjectConfigPath,
  parseWatcherArgs,
  resolveEffectiveConfig,
} from "../src/index";

const tempDirs: string[] = [];

function makeTempProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-watcher-test-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(
  cwd: string,
  config: Record<string, unknown>,
): void {
  const projectPath = getProjectConfigPath(cwd);
  mkdirSync(projectPath.dir, { recursive: true });
  writeFileSync(projectPath.path, `${JSON.stringify(config, null, 2)}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type CapturedCommand = {
  handler: (args: string, ctx: MockContext) => Promise<void>;
};

type MockContext = {
  cwd: string;
  hasUI: boolean;
  hasPendingMessages: () => boolean;
  isIdle: () => boolean;
  ui: {
    notify: (message: string, type?: "error" | "info" | "warning") => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
};

function createMockContext(cwd: string): {
  ctx: MockContext;
  notifications: string[];
  statuses: string[];
} {
  const notifications: string[] = [];
  const statuses: string[] = [];

  return {
    ctx: {
      cwd,
      hasPendingMessages: () => false,
      hasUI: true,
      isIdle: () => true,
      ui: {
        notify: (message) => notifications.push(message),
        setStatus: (key, text) => statuses.push(`${key}:${text ?? ""}`),
      },
    },
    notifications,
    statuses,
  };
}

function createExtensionHarness(): {
  command: CapturedCommand;
  emit: (event: string, ctx: MockContext) => Promise<void>;
  sent: string[];
} {
  const handlers = new Map<
    string,
    (event: Record<string, never>, ctx: MockContext) => Promise<void> | void
  >();
  const sent: string[] = [];
  let command: CapturedCommand | undefined;

  piWatcherExtension({
    appendEntry: () => undefined,
    on: (event: string, handler: unknown) => {
      handlers.set(
        event,
        handler as (
          event: Record<string, never>,
          ctx: MockContext,
        ) => Promise<void> | void,
      );
    },
    registerCommand: (name: string, options: CapturedCommand) => {
      if (name === "watcher") {
        command = options;
      }
    },
    sendUserMessage: (prompt: string) => {
      sent.push(prompt);
    },
  } as never);

  if (!command) {
    throw new Error("/watcher command was not registered");
  }

  return {
    command,
    emit: async (event, ctx) => {
      await handlers.get(event)?.({}, ctx);
    },
    sent,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("pi-watcher scaffold", () => {
  it("stores project config under cwd .pi/extensions", () => {
    expect(getProjectConfigPath("/repo")).toEqual({
      dir: "/repo/.pi/extensions",
      path: "/repo/.pi/extensions/pi-watcher.json",
    });
  });

  it("defaults watcher config to enabled with MVP runtime options", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      busyPolicy: "queue_until_idle",
      enabled: true,
      maxFileBytes: 1_048_576,
      marker: "AI",
      roots: ["."],
      scanOnStart: true,
    });
    expect(resolveEffectiveConfig()).toMatchObject(DEFAULT_CONFIG);
  });

  it("merges config with project taking precedence while keeping defaults", () => {
    expect(
      resolveEffectiveConfig(
        { debounceMs: 100, enabled: false, roots: ["src"] },
        { enabled: true, maxPromptBytes: 123 },
      ),
    ).toMatchObject({
      debounceMs: 100,
      enabled: true,
      maxPromptBytes: 123,
      roots: ["src"],
      scanOnStart: true,
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
    const cwd = makeTempProject();
    writeProjectConfig(cwd, { enabled: true });

    expect(formatWatcherStatus(cwd)).toContain("pi-watcher: enabled");
    expect(formatWatcherStatus(cwd)).toContain(
      `project config: ${cwd}/.pi/extensions/pi-watcher.json`,
    );
  });

  it("auto-starts on session_start when effective config is enabled", async () => {
    const cwd = makeTempProject();
    writeProjectConfig(cwd, { enabled: true });
    const harness = createExtensionHarness();
    const { ctx, statuses } = createMockContext(cwd);

    await harness.emit("session_start", ctx);

    expect(statuses).toContain("pi-watcher:watcher on");
    await harness.emit("session_shutdown", ctx);
  });

  it("stays off on session_start when project config disables watcher", async () => {
    const cwd = makeTempProject();
    writeProjectConfig(cwd, { enabled: false });
    const harness = createExtensionHarness();
    const { ctx, statuses } = createMockContext(cwd);

    await harness.emit("session_start", ctx);

    expect(statuses).toContain("pi-watcher:watcher off");
    await harness.emit("session_shutdown", ctx);
  });

  it("start and stop update project config and runtime state", async () => {
    const cwd = makeTempProject();
    const harness = createExtensionHarness();
    const { ctx, statuses } = createMockContext(cwd);

    await harness.command.handler("start", ctx);
    expect(
      JSON.parse(readFileSync(getProjectConfigPath(cwd).path, "utf-8")),
    ).toEqual({
      enabled: true,
    });
    expect(statuses).toContain("pi-watcher:watcher on");

    await harness.command.handler("stop", ctx);
    expect(
      JSON.parse(readFileSync(getProjectConfigPath(cwd).path, "utf-8")),
    ).toEqual({
      enabled: false,
    });
    expect(statuses).toContain("pi-watcher:watcher off");
  });

  it("closes the running watcher on session_shutdown", async () => {
    const cwd = makeTempProject();
    writeProjectConfig(cwd, {
      debounceMs: 20,
      enabled: true,
      scanOnStart: false,
    });
    const harness = createExtensionHarness();
    const { ctx, statuses } = createMockContext(cwd);

    await harness.emit("session_start", ctx);
    await harness.emit("session_shutdown", ctx);
    writeFileSync(join(cwd, "after-shutdown.ts"), "// no dispatch AI!\n");
    await sleep(150);

    expect(statuses).toContain("pi-watcher:watcher off");
    expect(harness.sent).toHaveLength(0);
  });
});
