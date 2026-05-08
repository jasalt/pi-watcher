import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/index";
import type { WatcherBatch } from "../src/state";
import { PiFileWatcher } from "../src/watcher";

const tempDirs: string[] = [];
const openWatchers: PiFileWatcher[] = [];

function makeTempProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-watcher-test-"));
  tempDirs.push(cwd);
  return cwd;
}

function makeWatcher(
  cwd: string,
  batches: WatcherBatch[] = [],
  overrides: Partial<ConstructorParameters<typeof PiFileWatcher>[0]> = {},
): PiFileWatcher {
  const watcher = new PiFileWatcher({
    cwd,
    debounceMs: 20,
    ignore: DEFAULT_CONFIG.ignore,
    include: DEFAULT_CONFIG.include,
    marker: DEFAULT_CONFIG.marker,
    maxFileBytes: DEFAULT_CONFIG.maxFileBytes,
    onBatch: (batch) => {
      batches.push(batch);
    },
    roots: DEFAULT_CONFIG.roots,
    ...overrides,
  });
  openWatchers.push(watcher);
  return watcher;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for watcher event");
    }
    await sleep(20);
  }
}

afterEach(async () => {
  await Promise.all(openWatchers.splice(0).map((watcher) => watcher.close()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("PiFileWatcher", () => {
  it("detects changed marker files in a temp project", async () => {
    const cwd = makeTempProject();
    const batches: WatcherBatch[] = [];
    const watcher = makeWatcher(cwd, batches);

    await watcher.start();
    await sleep(50);
    writeFileSync(join(cwd, "task.ts"), "// handle null AI!\nrun();\n");

    await waitFor(() => batches.length >= 1, 2_000);

    expect(batches[0]).toMatchObject({ reason: "file_change" });
    expect(batches[0].files).toHaveLength(1);
    expect(batches[0].files[0]).toMatchObject({ path: "task.ts" });
    expect(batches[0].files[0]?.markers[0]).toMatchObject({
      action: "edit",
      line: 1,
    });
  });

  it("does not trigger for ignored paths", async () => {
    const cwd = makeTempProject();
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), "ignored-by-git.ts\n");
    const batches: WatcherBatch[] = [];
    const watcher = makeWatcher(cwd, batches);

    await watcher.start();
    writeFileSync(join(cwd, "node_modules", "pkg", "skip.ts"), "// skip AI!\n");
    writeFileSync(join(cwd, "ignored-by-git.ts"), "// skip AI!\n");
    await sleep(150);

    expect(batches).toHaveLength(0);

    writeFileSync(join(cwd, "keep.ts"), "// keep AI!\n");
    await waitFor(() => batches.length >= 1);

    expect(batches[0].files.map((file) => file.path)).toEqual(["keep.ts"]);
  });

  it("does not scan roots outside the project cwd", async () => {
    const cwd = makeTempProject();
    const outside = makeTempProject();
    writeFileSync(join(outside, "leak.ts"), "// do not read AI!\n");
    const batches: WatcherBatch[] = [];
    const watcher = makeWatcher(cwd, batches, { roots: [outside] });

    const batch = await watcher.scan();

    expect(batch).toBeNull();
    expect(batches).toHaveLength(0);
  });

  it("skips large and binary files during scans", async () => {
    const cwd = makeTempProject();
    writeFileSync(join(cwd, "large.ts"), `// ${"x".repeat(64)} AI!\n`);
    writeFileSync(
      join(cwd, "binary.ts"),
      Buffer.from([0, 47, 47, 32, 65, 73, 33]),
    );
    const batches: WatcherBatch[] = [];
    const watcher = makeWatcher(cwd, batches, { maxFileBytes: 16 });

    const batch = await watcher.scan();

    expect(batch).toBeNull();
    expect(batches).toHaveLength(0);
  });

  it("closes cleanly and ignores later saves", async () => {
    const cwd = makeTempProject();
    const batches: WatcherBatch[] = [];
    const watcher = makeWatcher(cwd, batches);

    await watcher.start();
    await watcher.close();
    writeFileSync(join(cwd, "after-close.ts"), "// should not run AI!\n");
    await sleep(150);

    expect(watcher.isClosed()).toBe(true);
    expect(batches).toHaveLength(0);
  });
});
