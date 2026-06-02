import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function writeLiveProjectConfig(cwd: string): void {
  writeProjectConfig(cwd, {
    debounceMs: 20,
    enabled: true,
    scanOnStart: false,
  });
}

function readProjectConfig(cwd: string): unknown {
  return JSON.parse(readFileSync(getProjectConfigPath(cwd).path, "utf-8"));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for watcher integration event");
    }
    await sleep(20);
  }
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
    setWidget: (key: string, lines: string[] | undefined) => void;
  };
};

function createMockContext(
  cwd: string,
  options: { hasUI?: boolean; idle?: boolean; throwOnUi?: boolean } = {},
): {
  ctx: MockContext;
  statuses: string[];
  widgets: string[];
} {
  const statuses: string[] = [];
  const widgets: string[] = [];
  const maybeThrow = () => {
    if (options.throwOnUi) {
      throw new Error("ctx.ui should not be called when hasUI is false");
    }
  };

  return {
    ctx: {
      cwd,
      hasPendingMessages: () => false,
      hasUI: options.hasUI ?? true,
      isIdle: () => options.idle ?? true,
      ui: {
        notify: () => {
          maybeThrow();
        },
        setStatus: (key, text) => {
          maybeThrow();
          statuses.push(`${key}:${text ?? ""}`);
        },
        setWidget: (key, lines) => {
          maybeThrow();
          widgets.push(`${key}:${lines?.join("|") ?? ""}`);
        },
      },
    },
    statuses,
    widgets,
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
      removeHandledMarkerComments: true,
      roots: ["."],
      scanOnStart: true,
    });
    expect("removeHandledActionComments" in DEFAULT_CONFIG).toBe(false);
    expect("removeContextAnchorsInActionBlock" in DEFAULT_CONFIG).toBe(false);
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
    const { ctx, statuses, widgets } = createMockContext(cwd);

    await harness.emit("session_start", ctx);

    expect(statuses).toContain("pi-watcher:watcher on");
    expect(widgets).toContain(
      "pi-watcher:pi-watcher: on|queued markers: 0|last trigger: none",
    );
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
    expect(readProjectConfig(cwd)).toEqual({
      enabled: true,
    });
    expect(statuses).toContain("pi-watcher:watcher on");

    await harness.command.handler("stop", ctx);
    expect(readProjectConfig(cwd)).toEqual({
      enabled: false,
    });
    expect(statuses).toContain("pi-watcher:watcher off");
  });

  it("closes the running watcher on session_shutdown", async () => {
    const cwd = makeTempProject();
    writeLiveProjectConfig(cwd);
    const harness = createExtensionHarness();
    const { ctx, statuses } = createMockContext(cwd);

    await harness.emit("session_start", ctx);
    await harness.emit("session_shutdown", ctx);
    writeFileSync(join(cwd, "after-shutdown.ts"), "// no dispatch AI!\n");
    await sleep(150);

    expect(statuses).toContain("pi-watcher:watcher off");
    expect(harness.sent).toHaveLength(0);
  });

  it("auto-starts and dispatches saved AI! comments without /watcher start", async () => {
    const cwd = makeTempProject();
    writeLiveProjectConfig(cwd);
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.emit("session_start", ctx);
      await sleep(50);
      writeFileSync(join(cwd, "sample.ts"), "// handle null AI!\nrun();\n");

      await waitFor(() => harness.sent.length === 1, 4_000);

      expect(harness.sent[0]).toContain("sample.ts:1 action=edit");
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("persists /watcher stop and start while toggling live dispatch", async () => {
    const cwd = makeTempProject();
    writeLiveProjectConfig(cwd);
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.emit("session_start", ctx);
      const stoppedPath = join(cwd, "stopped.ts");
      await harness.command.handler("stop", ctx);
      writeFileSync(stoppedPath, "// should not run AI!\n");
      await sleep(150);

      expect(readProjectConfig(cwd)).toEqual({
        enabled: false,
      });
      expect(harness.sent).toHaveLength(0);

      writeFileSync(stoppedPath, "export const stopped = true;\n");
      await harness.command.handler("start", ctx);
      writeFileSync(join(cwd, "started.ts"), "// run now AI!\n");
      await waitFor(() => harness.sent.length === 1);

      expect(readProjectConfig(cwd)).toEqual({
        enabled: true,
      });
      expect(harness.sent[0]).toContain("started.ts:1 action=edit");
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("removes handled AI! trigger comment blocks after agent_end", async () => {
    const cwd = makeTempProject();
    const path = join(cwd, "cleanup.ts");
    writeLiveProjectConfig(cwd);
    writeFileSync(
      path,
      [
        "// keep nearby context AI.",
        "// explain constraints",
        "// add guard AI!",
        "// keep null-safe",
        "export const value = compute(); // handle inline AI!",
        "run();",
        "",
      ].join("\n"),
    );
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.command.handler("scan", ctx);
      expect(harness.sent).toHaveLength(1);

      await harness.emit("agent_end", ctx);

      expect(readFileSync(path, "utf-8")).toBe(
        ["export const value = compute();", "run();", ""].join("\n"),
      );
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("removes handled AI? trigger comments after agent_end", async () => {
    const cwd = makeTempProject();
    const path = join(cwd, "cleanup-question.py");
    writeLiveProjectConfig(cwd);
    writeFileSync(path, "# why not use sum AI?\nvalue = 1\n");
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.command.handler("scan", ctx);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]).toContain("cleanup-question.py:1 action=ask");

      await harness.emit("agent_end", ctx);

      expect(readFileSync(path, "utf-8")).toBe("value = 1\n");
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("keeps handled marker comments when cleanup config is disabled", async () => {
    const cwd = makeTempProject();
    const path = join(cwd, "cleanup-disabled.ts");
    writeProjectConfig(cwd, {
      debounceMs: 20,
      enabled: true,
      removeHandledMarkerComments: false,
      scanOnStart: false,
    });
    writeFileSync(
      path,
      "// keep context AI.\n// add guard AI!\n# why AI?\nrun();\n",
    );
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.command.handler("scan", ctx);
      expect(harness.sent).toHaveLength(1);

      await harness.emit("agent_end", ctx);

      expect(readFileSync(path, "utf-8")).toBe(
        "// keep context AI.\n// add guard AI!\n# why AI?\nrun();\n",
      );
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("removes handled AI. context anchors by default", async () => {
    const cwd = makeTempProject();
    const contextPath = join(cwd, "cleanup-context.ts");
    const actionPath = join(cwd, "cleanup-action.ts");
    writeLiveProjectConfig(cwd);
    writeFileSync(
      contextPath,
      "const context = true; // keep this context AI.\n",
    );
    writeFileSync(actionPath, "// add guard AI!\nrun();\n");
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.command.handler("scan", ctx);
      expect(harness.sent).toHaveLength(1);

      await harness.emit("agent_end", ctx);

      expect(readFileSync(contextPath, "utf-8")).toBe(
        "const context = true;\n",
      );
      expect(readFileSync(actionPath, "utf-8")).toBe("run();\n");
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("preserves adjacent inline comments that are not trigger lines", async () => {
    const cwd = makeTempProject();
    const path = join(cwd, "cleanup-inline.ts");
    writeLiveProjectConfig(cwd);
    writeFileSync(
      path,
      "const a = 1; // fix this AI!\nconst b = 2; // keep this note\n",
    );
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.command.handler("scan", ctx);
      expect(harness.sent).toHaveLength(1);

      await harness.emit("agent_end", ctx);

      expect(readFileSync(path, "utf-8")).toBe(
        "const a = 1;\nconst b = 2; // keep this note\n",
      );
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("does not clean up through a symlink swapped in after scan", async () => {
    const cwd = makeTempProject();
    const outside = makeTempProject();
    const path = join(cwd, "cleanup-symlink.ts");
    const outsidePath = join(outside, "outside.ts");
    writeLiveProjectConfig(cwd);
    writeFileSync(path, "// add guard AI!\nrun();\n");
    writeFileSync(outsidePath, "// add guard AI!\nrun();\n");
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.command.handler("scan", ctx);
      expect(harness.sent).toHaveLength(1);

      rmSync(path);
      symlinkSync(outsidePath, path);
      await harness.emit("agent_end", ctx);

      expect(readFileSync(outsidePath, "utf-8")).toBe(
        "// add guard AI!\nrun();\n",
      );
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("does not clean up through a parent directory symlink swapped in after scan", async () => {
    const cwd = makeTempProject();
    const outside = makeTempProject();
    const nestedDir = join(cwd, "nested");
    const path = join(nestedDir, "cleanup-parent-symlink.ts");
    const outsidePath = join(outside, "cleanup-parent-symlink.ts");
    mkdirSync(nestedDir);
    writeLiveProjectConfig(cwd);
    writeFileSync(path, "// add guard AI!\nrun();\n");
    writeFileSync(outsidePath, "// add guard AI!\nrun();\n");
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.command.handler("scan", ctx);
      expect(harness.sent).toHaveLength(1);

      rmSync(nestedDir, { recursive: true });
      symlinkSync(outside, nestedDir);
      await harness.emit("agent_end", ctx);

      expect(readFileSync(outsidePath, "utf-8")).toBe(
        "// add guard AI!\nrun();\n",
      );
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("does not repeat an unchanged AI! comment after agent_end even if nearby code changes", async () => {
    const cwd = makeTempProject();
    const path = join(cwd, "loop.ts");
    writeLiveProjectConfig(cwd);
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.emit("session_start", ctx);
      writeFileSync(path, "// add guard AI!\nexport const value = 1;\n");
      await waitFor(() => harness.sent.length === 1);

      await harness.emit("agent_end", ctx);
      writeFileSync(
        path,
        "// add guard AI!\nexport const value = 2;\nexport const other = 3;\n",
      );
      await sleep(150);

      expect(harness.sent).toHaveLength(1);
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("dispatches AI? comments as answer-only prompts", async () => {
    const cwd = makeTempProject();
    writeLiveProjectConfig(cwd);
    writeFileSync(join(cwd, "question.py"), "# why not use sum AI?\n");
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd);

    try {
      await harness.emit("session_start", ctx);
      await harness.command.handler("scan", ctx);

      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]).toContain(
        "Answer the AI? comments. Do not edit files unless a comment explicitly asks for edits.",
      );
      expect(harness.sent[0]).toContain("question.py:1 action=ask");
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("shows queued state and last trigger in the UI widget", async () => {
    const cwd = makeTempProject();
    writeLiveProjectConfig(cwd);
    writeFileSync(join(cwd, "queued.ts"), "// do later AI!\nrun();\n");
    const harness = createExtensionHarness();
    const { ctx, statuses, widgets } = createMockContext(cwd, { idle: false });

    try {
      await harness.emit("session_start", ctx);
      await harness.command.handler("scan", ctx);

      expect(statuses).toContain("pi-watcher:watcher queued");
      expect(harness.sent).toHaveLength(0);
      expect(widgets.at(-1)).toBe(
        "pi-watcher:pi-watcher: queued|queued markers: 1|last trigger: manual_scan (1 marker) queued.ts:1",
      );
    } finally {
      await harness.emit("session_shutdown", ctx);
    }
  });

  it("guards all UI updates when ctx.hasUI is false", async () => {
    const cwd = makeTempProject();
    writeProjectConfig(cwd, { enabled: true });
    const harness = createExtensionHarness();
    const { ctx } = createMockContext(cwd, {
      hasUI: false,
      throwOnUi: true,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await harness.emit("session_start", ctx);
      await harness.command.handler("status", ctx);
      await harness.emit("session_shutdown", ctx);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("pi-watcher: enabled"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("runtime: watcher off"),
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
