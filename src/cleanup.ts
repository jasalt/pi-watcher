import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type ParsedAiMarker, findLineComment, parseAiMarkers } from "./parser";
import { type CompletedWatcherBatch, createMarkerIntentId } from "./state";

interface CleanupConfig {
  marker: string;
  removeContextAnchorsInActionBlock: boolean;
  removeHandledActionComments: boolean;
}

// [ref:line_comment_parsing] Shared parser helper supplies comment spans for
// stripping inline trigger comments without deleting code.

function commentPrefixStart(line: string): number | null {
  return findLineComment(line)?.start ?? null;
}

function isStandaloneCommentLine(line: string): boolean {
  const start = commentPrefixStart(line);
  return start !== null && line.slice(0, start).trim() === "";
}

function removeLineCommentFromLine(line: string): string | null {
  const start = commentPrefixStart(line);
  if (start === null) {
    return line;
  }

  const before = line.slice(0, start);
  if (before.trim() === "") {
    return null;
  }

  return before.replace(/\s+$/, "");
}

function isWithinPath(parent: string, child: string): boolean {
  const relativeToParent = relative(parent, child);
  return (
    relativeToParent === "" ||
    (relativeToParent !== ".." &&
      !relativeToParent.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToParent))
  );
}

function resolvePathWithinCwd(cwd: string, path: string): string | null {
  const base = resolve(cwd);
  const candidate = resolve(base, path);

  return isWithinPath(base, candidate) ? candidate : null;
}

function collectPreservedContextLines(
  currentMarkers: ParsedAiMarker[],
  handledMarkerIds: ReadonlySet<string>,
  removeContextAnchorsInActionBlock: boolean,
): Set<number> {
  const preserved = new Set<number>();
  if (removeContextAnchorsInActionBlock) {
    return preserved;
  }

  for (const marker of currentMarkers) {
    if (
      marker.action === "context" &&
      handledMarkerIds.has(createMarkerIntentId(marker))
    ) {
      preserved.add(marker.line);
    }
  }

  return preserved;
}

function collectLinesToClean(
  lines: string[],
  handledActionMarkers: ParsedAiMarker[],
  preservedContextLines: ReadonlySet<number>,
): Set<number> {
  const linesToClean = new Set<number>();
  const handledActionLines = new Set(
    handledActionMarkers.map((marker) => marker.line),
  );

  for (const marker of handledActionMarkers) {
    for (
      let lineNumber = marker.block.startLine;
      lineNumber <= marker.block.endLine;
      lineNumber += 1
    ) {
      const line = lines[lineNumber - 1];
      if (
        lineNumber <= 0 ||
        lineNumber > lines.length ||
        preservedContextLines.has(lineNumber) ||
        (line !== undefined &&
          !handledActionLines.has(lineNumber) &&
          !isStandaloneCommentLine(line))
      ) {
        continue;
      }

      linesToClean.add(lineNumber);
    }
  }

  return linesToClean;
}

function isCleanupCandidateFile(cwd: string, path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return false;
    }

    return isWithinPath(realpathSync(cwd), realpathSync(path));
  } catch {
    return false;
  }
}

function removeHandledMarkerBlocksFromContent(
  content: string,
  currentMarkers: ParsedAiMarker[],
  handledMarkerIds: ReadonlySet<string>,
  removeContextAnchorsInActionBlock: boolean,
): string {
  const handledActionMarkers = currentMarkers.filter(
    (marker) =>
      marker.action !== "context" &&
      handledMarkerIds.has(createMarkerIntentId(marker)),
  );

  if (handledActionMarkers.length === 0) {
    return content;
  }

  const lines = content.split(/\r\n|\n|\r/);
  const lineEnding = content.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const preservedContextLines = collectPreservedContextLines(
    currentMarkers,
    handledMarkerIds,
    removeContextAnchorsInActionBlock,
  );
  const linesToClean = collectLinesToClean(
    lines,
    handledActionMarkers,
    preservedContextLines,
  );

  const output: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!linesToClean.has(i + 1)) {
      output.push(lines[i]);
      continue;
    }

    const nextLine = removeLineCommentFromLine(lines[i]);
    if (nextLine !== null) {
      output.push(nextLine);
    }
  }

  return output.join(lineEnding);
}

export function cleanupHandledActionComments(
  cwd: string,
  completed: CompletedWatcherBatch | null,
  config: CleanupConfig,
): void {
  if (!config.removeHandledActionComments || !completed) {
    return;
  }

  const handledMarkerIds = new Set(completed.markerIds);
  if (handledMarkerIds.size === 0) {
    return;
  }

  for (const file of completed.batch.files) {
    const absolutePath = resolvePathWithinCwd(cwd, file.path);
    if (!absolutePath || !isCleanupCandidateFile(cwd, absolutePath)) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }

    const currentMarkers = parseAiMarkers(content, {
      marker: config.marker,
      path: file.path,
    });
    const nextContent = removeHandledMarkerBlocksFromContent(
      content,
      currentMarkers,
      handledMarkerIds,
      config.removeContextAnchorsInActionBlock,
    );

    if (nextContent === content) {
      continue;
    }

    try {
      if (!isCleanupCandidateFile(cwd, absolutePath)) {
        continue;
      }

      writeFileSync(absolutePath, nextContent);
    } catch {
      // Ignore cleanup races or permission errors; watcher state is already safe.
    }
  }
}
