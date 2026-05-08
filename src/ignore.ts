import { type Stats, existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignoreFactory from "ignore";
import { minimatch } from "minimatch";

const BUILT_IN_IGNORE_GLOBS = [
  "**/.git/**",
  "**/.jj/**",
  "**/.pi/**",
  "**/.agents/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/.DS_Store",
  "**/*.swp",
  "**/*.swo",
  "**/*~",
] as const;

interface IgnoreMatcherOptions {
  cwd: string;
  ignore?: readonly string[];
  include?: readonly string[];
  roots?: readonly string[];
}

export interface FileClassification {
  content?: string;
  reason?: string;
  relativePath: string;
  skipped: boolean;
}

export interface FileClassificationOptions {
  maxFileBytes?: number;
}

export interface IgnoreMatcher {
  classifyFile: (
    path: string,
    options?: FileClassificationOptions,
  ) => FileClassification;
  isIgnoredPath: (path: string, isDirectory?: boolean) => boolean;
  isIncludedFile: (path: string) => boolean;
  isWithinRoots: (path: string) => boolean;
  relativePath: (path: string) => string;
}

const MATCH_OPTIONS = { dot: true } as const;

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

function normalizePatterns(patterns: readonly string[] | undefined): string[] {
  return [...(patterns ?? [])].filter((pattern) => pattern.trim() !== "");
}

export function resolveRootPaths(
  cwd: string,
  roots: readonly string[] | undefined,
): string[] {
  const base = resolve(cwd);
  const configuredRoots = roots && roots.length > 0 ? roots : ["."];

  return configuredRoots
    .map((root) => resolve(base, root))
    .filter((rootPath) => isWithin(base, rootPath));
}

function globMatches(
  relativePath: string,
  patterns: readonly string[],
  isDirectory: boolean,
): boolean {
  const candidates =
    isDirectory && relativePath !== "."
      ? [relativePath, `${relativePath}/`]
      : [relativePath];

  return patterns.some((pattern) =>
    candidates.some((candidate) =>
      minimatch(candidate, pattern, MATCH_OPTIONS),
    ),
  );
}

function canUseGitignore(relativePath: string): boolean {
  return !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function createIgnoreMatcher(
  options: IgnoreMatcherOptions,
): IgnoreMatcher {
  const cwd = resolve(options.cwd);
  const rootPaths = resolveRootPaths(cwd, options.roots);
  const includePatterns = normalizePatterns(options.include);
  const ignorePatterns = [
    ...BUILT_IN_IGNORE_GLOBS,
    ...normalizePatterns(options.ignore),
  ];
  const gitignore = ignoreFactory();
  const gitignorePath = join(cwd, ".gitignore");

  if (existsSync(gitignorePath)) {
    try {
      gitignore.add(readFileSync(gitignorePath, "utf-8"));
    } catch {
      // Ignore unreadable .gitignore files; explicit config ignores still apply.
    }
  }

  function absolutePath(path: string): string {
    return resolve(cwd, path);
  }

  function relativePath(path: string): string {
    const relativeToCwd = relative(cwd, absolutePath(path));
    return relativeToCwd === "" ? "." : toPosixPath(relativeToCwd);
  }

  function isWithinRoots(path: string): boolean {
    const absolute = absolutePath(path);
    return rootPaths.some((rootPath) => isWithin(rootPath, absolute));
  }

  function isIgnoredPath(path: string, isDirectory = false): boolean {
    const rel = relativePath(path);

    if (rel === ".") {
      return false;
    }

    if (!isWithinRoots(path)) {
      return true;
    }

    if (globMatches(rel, ignorePatterns, isDirectory)) {
      return true;
    }

    const gitignoreCandidate = isDirectory ? `${rel}/` : rel;
    return canUseGitignore(gitignoreCandidate)
      ? gitignore.ignores(gitignoreCandidate)
      : false;
  }

  function isIncludedFile(path: string): boolean {
    const rel = relativePath(path);
    if (includePatterns.length === 0) {
      return true;
    }

    return globMatches(rel, includePatterns, false);
  }

  function classifyFile(
    path: string,
    classificationOptions: FileClassificationOptions = {},
  ): FileClassification {
    const rel = relativePath(path);
    let stats: Stats;

    try {
      stats = lstatSync(absolutePath(path));
    } catch {
      return { reason: "missing", relativePath: rel, skipped: true };
    }

    if (stats.isSymbolicLink()) {
      return { reason: "symlink", relativePath: rel, skipped: true };
    }

    if (!stats.isFile()) {
      return { reason: "not_file", relativePath: rel, skipped: true };
    }

    if (isIgnoredPath(path, false)) {
      return { reason: "ignored", relativePath: rel, skipped: true };
    }

    if (!isIncludedFile(path)) {
      return { reason: "not_included", relativePath: rel, skipped: true };
    }

    const maxFileBytes =
      classificationOptions.maxFileBytes ?? Number.POSITIVE_INFINITY;
    if (stats.size > maxFileBytes) {
      return { reason: "too_large", relativePath: rel, skipped: true };
    }

    let buffer: Buffer;
    try {
      buffer = readFileSync(absolutePath(path));
    } catch {
      return { reason: "unreadable", relativePath: rel, skipped: true };
    }

    if (!isUtf8Text(buffer)) {
      return { reason: "binary", relativePath: rel, skipped: true };
    }

    return {
      content: buffer.toString("utf-8"),
      relativePath: rel,
      skipped: false,
    };
  }

  return {
    classifyFile,
    isIgnoredPath,
    isIncludedFile,
    isWithinRoots,
    relativePath,
  };
}
