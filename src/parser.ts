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
  commentPrefix: string;
  commentPrefixKind: string;
  text: string;
}

const DEFAULT_MARKER = "AI";

function buildMarkerRegex(marker: string): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)(${escaped}(?:[!?]|\\.))(?=$|[^A-Za-z0-9_])`, "gi");
}

function normalizeCommentPrefix(prefix: string): string {
  return prefix.startsWith(";") ? ";" : prefix;
}

function normalizeLine(line: string): string {
  return line.trim();
}

function makeParsedCommentLine(
  prefix: string,
  text: string,
): ParsedCommentLine {
  return {
    commentPrefix: prefix,
    commentPrefixKind: normalizeCommentPrefix(prefix),
    text: normalizeLine(text),
  };
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
      return makeParsedCommentLine("#", line.slice(i + 1));
    }

    if (char === "/" && line[i + 1] === "/") {
      return makeParsedCommentLine("//", line.slice(i + 2));
    }

    if (char === "-" && line[i + 1] === "-") {
      return makeParsedCommentLine("--", line.slice(i + 2));
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

      return makeParsedCommentLine(line.slice(i, j), line.slice(j));
    }
  }

  return null;
}

function markerActionFromText(markerText: string): AiMarkerAction {
  if (markerText.endsWith("!")) {
    return "edit";
  }

  if (markerText.endsWith("?")) {
    return "ask";
  }

  return "context";
}

function parseMarkerToken(
  text: string,
  markerPattern: RegExp,
): { markerText: string; action: AiMarkerAction } | null {
  const trimmedText = text.trim();
  const matcher = new RegExp(markerPattern.source, markerPattern.flags);

  let endMatch: RegExpExecArray | null = null;
  for (const match of trimmedText.matchAll(matcher)) {
    if (match.index === 0) {
      const markerText = match[2];
      return { markerText, action: markerActionFromText(markerText) };
    }

    if (match.index + match[0].length === trimmedText.length) {
      endMatch = match;
    }
  }

  if (!endMatch) {
    return null;
  }

  const markerText = endMatch[2];
  return { markerText, action: markerActionFromText(markerText) };
}

function buildContextInput(
  path: string,
  normalizedBlock: string,
  lines: string[],
): string {
  if (lines.length === 0) {
    return `${path}\n${normalizedBlock}`;
  }

  return `${path}\n${normalizedBlock}\n${lines.join("\n")}`;
}

export function parseAiMarkers(
  source: string,
  options: ParseAiMarkersOptions = {},
): ParsedAiMarker[] {
  const path = options.path ?? "";
  const markerWord = options.marker ?? DEFAULT_MARKER;
  const markerPattern = buildMarkerRegex(markerWord);
  const lines = source.split(/\r\n|\n|\r/);
  const parsedLines: Array<ParsedCommentLine | null> = lines.map((line) =>
    findLineComment(line),
  );

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
  }

  return markers;
}
