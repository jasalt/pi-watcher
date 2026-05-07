export type AiMarkerAction = "edit" | "ask" | "context";

export interface AiMarkerBlock {
  startLine: number;
  endLine: number;
  lines: string[];
}

export interface ParsedAiMarker {
  action: AiMarkerAction;
  block: AiMarkerBlock;
  commentPrefix: string;
  instruction: string;
  line: number;
  markerIntentInput: string;
  markerContextInput: string;
  markerText: string;
  normalizedBlock: string;
  path: string;
}

export interface ParseAiMarkersOptions {
  marker?: string;
  path?: string;
}

interface ParsedCommentLine {
  lineNumber: number;
  commentPrefix: string;
  commentPrefixKind: string;
  text: string;
}

const DEFAULT_MARKER = "AI";

function buildMarkerRegex(marker: string): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^A-Za-z0-9_])(${escaped}[!?]?)(?=$|[^A-Za-z0-9_])`,
    "gi",
  );
}

function normalizeCommentPrefix(prefix: string): string {
  return prefix.startsWith(";") ? ";" : prefix;
}

function normalizeLine(line: string): string {
  return line.trim();
}

function findLineComment(line: string): ParsedCommentLine | null {
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "#") {
      return {
        commentPrefix: "#",
        commentPrefixKind: "#",
        lineNumber: 0,
        text: normalizeLine(line.slice(i + 1)),
      };
    }

    if (char === "/" && line[i + 1] === "/") {
      return {
        commentPrefix: "//",
        commentPrefixKind: "//",
        lineNumber: 0,
        text: normalizeLine(line.slice(i + 2)),
      };
    }

    if (char === "-" && line[i + 1] === "-") {
      return {
        commentPrefix: "--",
        commentPrefixKind: "--",
        lineNumber: 0,
        text: normalizeLine(line.slice(i + 2)),
      };
    }

    if (char === ";") {
      const prefixStart = i;
      let j = i;
      while (j < line.length && line[j] === ";") {
        j += 1;
      }

      const preceding = line.slice(0, prefixStart);
      if (preceding.trim() !== "") {
        continue;
      }

      return {
        commentPrefix: line.slice(i, j),
        commentPrefixKind: normalizeCommentPrefix(line.slice(i, j)),
        lineNumber: 0,
        text: normalizeLine(line.slice(j)),
      };
    }
  }

  return null;
}

function parseMarkerToken(
  text: string,
  markerPattern: RegExp,
): { markerText: string; action: AiMarkerAction } | null {
  const trimmedText = text.trim();
  const startPattern = new RegExp(markerPattern.source, markerPattern.flags);
  const startMatch = startPattern.exec(trimmedText);
  const markerAtStart = startMatch?.index === 0;

  const endPattern = new RegExp(markerPattern.source, markerPattern.flags);
  let endMatch: RegExpExecArray | null = null;
  let match = endPattern.exec(trimmedText);
  while (match) {
    if (match.index + match[0].length === trimmedText.length) {
      endMatch = match;
    }
    match = endPattern.exec(trimmedText);
  }

  const markerMatch = markerAtStart ? startMatch : endMatch;
  if (!markerMatch) {
    return null;
  }

  const markerText = markerMatch[2];

  if (markerText.endsWith("!")) {
    return { markerText, action: "edit" };
  }

  if (markerText.endsWith("?")) {
    return { markerText, action: "ask" };
  }

  return { markerText, action: "context" };
}

function buildContextInput(
  path: string,
  normalizedBlock: string,
  lines: string[],
): string {
  const safePath = path ?? "";
  if (lines.length === 0) {
    return `${safePath}\n${normalizedBlock}`;
  }

  return `${safePath}\n${normalizedBlock}\n${lines.join("\n")}`;
}

export function parseAiMarkers(
  source: string,
  options: ParseAiMarkersOptions = {},
): ParsedAiMarker[] {
  const path = options.path ?? "";
  const markerWord = options.marker ?? DEFAULT_MARKER;
  const markerPattern = buildMarkerRegex(markerWord);
  const lines = source.split(/\r\n|\n|\r/);
  const parsedLines: Array<ParsedCommentLine | null> = new Array(lines.length);

  for (let i = 0; i < lines.length; i += 1) {
    const comment = findLineComment(lines[i]);
    if (!comment) {
      continue;
    }

    parsedLines[i] = {
      ...comment,
      lineNumber: i + 1,
    };
  }

  const markers: ParsedAiMarker[] = [];

  for (let i = 0; i < parsedLines.length; i += 1) {
    const current = parsedLines[i];
    if (!current) {
      continue;
    }

    const markerResult = parseMarkerToken(current.text, markerPattern);
    if (!markerResult) {
      continue;
    }

    const { markerText, action } = markerResult;

    let start = i;
    while (start > 0) {
      const previous = parsedLines[start - 1];
      if (
        !previous ||
        previous.commentPrefixKind !== current.commentPrefixKind
      ) {
        break;
      }

      start -= 1;
    }

    let end = i;
    while (end + 1 < parsedLines.length) {
      const next = parsedLines[end + 1];
      if (!next || next.commentPrefixKind !== current.commentPrefixKind) {
        break;
      }

      end += 1;
    }

    const blockLines: string[] = [];
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
      const parsedLine = parsedLines[lineIndex];
      if (parsedLine) {
        blockLines.push(parsedLine.text);
      }
    }

    const instruction = current.text;
    const normalizedBlock = blockLines
      .map((value) => value.toLowerCase())
      .join("\n");
    const block: AiMarkerBlock = {
      startLine: start + 1,
      endLine: end + 1,
      lines: blockLines,
    };

    const markerIntentInput = `${path}\n${normalizedBlock}`;

    const contextSnippet = lines
      .slice(start, Math.min(lines.length, end + 2))
      .map((line) => line.trim())
      .join("\n");

    const markerContextInput = buildContextInput(
      path,
      normalizedBlock,
      contextSnippet ? [contextSnippet] : [],
    );

    markers.push({
      action,
      block,
      commentPrefix: current.commentPrefix,
      instruction,
      line: i + 1,
      markerIntentInput,
      markerContextInput,
      markerText,
      normalizedBlock,
      path,
    });

    markerPattern.lastIndex = 0;
  }

  return markers;
}
