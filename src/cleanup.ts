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
    const startLine = Math.max(1, marker.block.startLine);
    const endLine = Math.min(marker.block.endLine, lines.length);

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const line = lines[lineNumber - 1];
      if (handledMarkerLines.has(lineNumber) || isStandaloneCommentLine(line)) {
        linesToClean.add(lineNumber);
      }
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

function readCleanupContent(absolutePath: string, cwd: string): string | null {
  if (!isCleanupCandidateFile(cwd, absolutePath)) {
    return null;
  }

  try {
    return readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }
}

function writeCleanupContent(
  absolutePath: string,
  content: string,
  cwd: string,
): void {
  if (!isCleanupCandidateFile(cwd, absolutePath)) {
    return;
  }

  try {
    writeFileSync(absolutePath, content);
  } catch {
    // Ignore cleanup races or permission errors; watcher state is already safe.
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

function collectHandledMarkerIds(
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

  const handledMarkerIds = collectHandledMarkerIds(completed);
  if (handledMarkerIds.size === 0) {
    return;
  }

  for (const file of completed.batch.files) {
    const absolutePath = resolvePathWithinCwd(cwd, file.path);
    if (!absolutePath) {
      continue;
    }

    const content = readCleanupContent(absolutePath, cwd);
    if (content === null) {
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

    if (nextContent !== content) {
      writeCleanupContent(absolutePath, nextContent, cwd);
    }
  }
}
