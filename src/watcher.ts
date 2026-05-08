import { type Stats, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import {
  type IgnoreMatcher,
  createIgnoreMatcher,
  resolveRootPaths,
} from "./ignore";
import { parseAiMarkers } from "./parser";
import type { WatcherFileState } from "./prompt";
import type { WatcherBatch } from "./state";

interface PiFileWatcherOptions {
  cwd: string;
  debounceMs: number;
  ignore: readonly string[];
  include: readonly string[];
  marker: string;
  maxFileBytes: number;
  onBatch?: (batch: WatcherBatch) => Promise<void> | void;
  onDelete?: (relativePath: string) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
  roots: readonly string[];
}

const DEFAULT_DEBOUNCE_MS = 300;

function hasActionableMarkers(files: WatcherFileState[]): boolean {
  return files.some((file) =>
    file.markers.some((marker) => marker.action !== "context"),
  );
}

function contextOnlyState(file: WatcherFileState): WatcherFileState | null {
  const markers = file.markers.filter((marker) => marker.action === "context");
  if (markers.length === 0) {
    return null;
  }

  return { ...file, markers };
}

function sortFiles(files: WatcherFileState[]): WatcherFileState[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class PiFileWatcher {
  private readonly knownFiles = new Map<string, WatcherFileState>();
  private readonly options: PiFileWatcherOptions;
  private closed = true;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private matcher: IgnoreMatcher;
  private readonly pendingPaths = new Set<string>();
  private settleStart: (() => void) | null = null;
  private watcher: FSWatcher | null = null;

  constructor(options: PiFileWatcherOptions) {
    this.options = options;
    this.matcher = this.createMatcher();
  }

  async start(): Promise<void> {
    if (this.watcher && !this.closed) {
      return;
    }

    this.closed = false;
    this.matcher = this.createMatcher();
    const roots = this.watchRoots();
    if (roots.length === 0) {
      return;
    }

    const watcher = watch(roots, {
      awaitWriteFinish: {
        pollInterval: Math.max(10, Math.min(100, this.options.debounceMs)),
        stabilityThreshold: this.debounceMs(),
      },
      followSymlinks: false,
      ignoreInitial: true,
      ignored: (path, stats) => this.isIgnoredForWatch(path.toString(), stats),
      persistent: true,
    });

    this.watcher = watcher;
    watcher.on("add", (path) => this.queuePath(path.toString()));
    watcher.on("change", (path) => this.queuePath(path.toString()));
    watcher.on("unlink", (path) => {
      void this.handleDeleted(path.toString());
    });
    watcher.on("error", (error) => {
      void this.options.onError?.(toError(error));
    });

    await new Promise<void>((resolveReady, rejectReady) => {
      const cleanup = () => {
        this.settleStart = null;
        watcher.off("ready", onReady);
        watcher.off("error", onError);
      };
      const onReady = () => {
        cleanup();
        resolveReady();
      };
      const onError = (error: unknown) => {
        cleanup();
        rejectReady(toError(error));
      };

      this.settleStart = onReady;
      watcher.once("ready", onReady);
      watcher.once("error", onError);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pendingPaths.clear();

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.settleStart?.();
    this.settleStart = null;

    const watcher = this.watcher;
    this.watcher = null;

    if (watcher) {
      await watcher.close();
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  async scan(reason = "manual_scan"): Promise<WatcherBatch | null> {
    this.matcher = this.createMatcher();
    this.knownFiles.clear();
    const batch = this.scanPaths(this.collectRootFiles(), reason);

    if (batch) {
      await this.options.onBatch?.(batch);
    }

    return batch;
  }

  private createMatcher(): IgnoreMatcher {
    return createIgnoreMatcher({
      cwd: this.options.cwd,
      ignore: this.options.ignore,
      include: this.options.include,
      roots: this.options.roots,
    });
  }

  private debounceMs(): number {
    const value = Math.trunc(this.options.debounceMs);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEBOUNCE_MS;
  }

  private watchRoots(): string[] {
    return resolveRootPaths(this.options.cwd, this.options.roots);
  }

  private isIgnoredForWatch(
    path: string,
    stats?: { isDirectory: () => boolean },
  ): boolean {
    let isDirectory = stats?.isDirectory() ?? false;

    if (!stats) {
      try {
        isDirectory = lstatSync(path).isDirectory();
      } catch {
        isDirectory = false;
      }
    }

    return this.matcher.isIgnoredPath(path, isDirectory);
  }

  private queuePath(path: string): void {
    if (this.closed) {
      return;
    }

    this.pendingPaths.add(resolve(this.options.cwd, path));
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPending();
    }, this.debounceMs());
  }

  private async flushPending(): Promise<void> {
    if (this.closed || this.pendingPaths.size === 0) {
      return;
    }

    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    const batch = this.scanPaths(paths, "file_change");

    if (batch && !this.closed) {
      await this.options.onBatch?.(batch);
    }

    if (!this.closed && this.pendingPaths.size > 0) {
      this.scheduleFlush();
    }
  }

  private async handleDeleted(path: string): Promise<void> {
    const relativePath = this.matcher.relativePath(path);
    this.knownFiles.delete(relativePath);
    await this.options.onDelete?.(relativePath);
  }

  private collectRootFiles(): string[] {
    const files: string[] = [];

    for (const root of this.watchRoots()) {
      this.collectFiles(root, files);
    }

    return files;
  }

  private collectFiles(path: string, files: string[]): void {
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch {
      return;
    }

    if (stats.isSymbolicLink()) {
      return;
    }

    if (stats.isDirectory()) {
      if (this.matcher.isIgnoredPath(path, true)) {
        return;
      }

      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }

      for (const entry of entries) {
        this.collectFiles(join(path, entry), files);
      }
      return;
    }

    if (stats.isFile()) {
      files.push(path);
    }
  }

  private scanPaths(paths: string[], reason: string): WatcherBatch | null {
    const changedFiles: WatcherFileState[] = [];

    for (const path of paths) {
      const classification = this.matcher.classifyFile(path, {
        maxFileBytes: this.options.maxFileBytes,
      });

      if (classification.skipped || classification.content === undefined) {
        this.knownFiles.delete(classification.relativePath);
        continue;
      }

      const markers = parseAiMarkers(classification.content, {
        marker: this.options.marker,
        path: classification.relativePath,
      });

      if (markers.length === 0) {
        this.knownFiles.delete(classification.relativePath);
        continue;
      }

      const fileState = {
        content: classification.content,
        markers,
        path: classification.relativePath,
      };

      this.knownFiles.set(classification.relativePath, fileState);
      changedFiles.push(fileState);
    }

    return this.buildBatch(changedFiles, reason);
  }

  private buildBatch(
    changedFiles: WatcherFileState[],
    reason: string,
  ): WatcherBatch | null {
    if (!hasActionableMarkers(changedFiles)) {
      return null;
    }

    const filesByPath = new Map<string, WatcherFileState>();
    for (const file of this.knownFiles.values()) {
      const contextFile = contextOnlyState(file);
      if (contextFile) {
        filesByPath.set(contextFile.path, contextFile);
      }
    }

    for (const file of changedFiles) {
      filesByPath.set(file.path, file);
    }

    return {
      files: sortFiles([...filesByPath.values()]),
      reason,
    };
  }
}
