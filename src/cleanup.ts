import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type ParsedAiMarker, findLineComment, parseAiMarkers } from "./parser";
import { type CompletedWatcherBatch, createMarkerIntentId } from "./state";

interface CleanupConfig {
  marker: string;
  removeHandledMarkerComments: boolean;
}

// [ref:line_comment_parsing] Shared parser helper supplies comment spans for
// stripping inline trigger comments without deleting code.

function isStandaloneCommentLine(line: string): boolean {
  const comment = findLineComment(line);
  return comment !== null && line.slice(0, comment.start).trim() === "";
}

function removeLineCommentFromLine(line: string): string | null {
  const comment = findLineComment(line);
  if (!comment) {
    return line;
  }

  const before = line.slice(0, comment.start);
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

function resolvePathWithinCwd(
  cwd: string,
  relativePath: string,
): string | null {
  const base = resolve(cwd);
  const absolutePath = resolve(base, relativePath);

  return isWithinPath(base, absolutePath) ? absolutePath : null;
}

function collectLinesToClean(
  lines: string[],
  handledMarkers: ParsedAiMarker[],
): Set<number> {
  const linesToClean = new Set<number>();
  const handledMarkerLines = new Set(
    handledMarkers.map((marker) => marker.line),
  );

  for (const marker of handledMarkers) {
    for (
      let lineNumber = marker.block.startLine;
      lineNumber <= marker.block.endLine;
      lineNumber += 1
    ) {
      if (lineNumber <= 0 || lineNumber > lines.length) {
        continue;
      }

      const line = lines[lineNumber - 1];
      if (
        !handledMarkerLines.has(lineNumber) &&
        !isStandaloneCommentLine(line)
      ) {
        continue;
      }

      linesToClean.add(lineNumber);
    }
  }

  return linesToClean;
}

function isCleanupCandidateFile(cwd: string, absolutePath: string): boolean {
  try {
    const stats = lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return false;
    }

    return isWithinPath(realpathSync(cwd), realpathSync(absolutePath));
  } catch {
    return false;
  }
}

function removeHandledMarkerBlocksFromContent(
  content: string,
  currentMarkers: ParsedAiMarker[],
  handledMarkerIds: ReadonlySet<string>,
): string {
  const handledMarkers = currentMarkers.filter((marker) =>
    handledMarkerIds.has(createMarkerIntentId(marker)),
  );

  if (handledMarkers.length === 0) {
    return content;
  }

  const lines = content.split(/\r\n|\n|\r/);
  const lineEnding = content.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const linesToClean = collectLinesToClean(lines, handledMarkers);

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

function collectCompletedMarkerIds(
  completed: CompletedWatcherBatch,
): Set<string> {
  return new Set(
    completed.batch.files
      .flatMap((file) => file.markers)
      .map((marker) => createMarkerIntentId(marker)),
  );
}

export function cleanupHandledMarkerComments(
  cwd: string,
  completed: CompletedWatcherBatch | null,
  config: CleanupConfig,
): void {
  if (!config.removeHandledMarkerComments || !completed) {
    return;
  }

  const handledMarkerIds = collectCompletedMarkerIds(completed);
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
