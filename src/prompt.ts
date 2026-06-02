import type { ParsedAiMarker } from "./parser";

export interface WatcherFileState {
  content: string;
  markers: ParsedAiMarker[];
  path: string;
}

export interface BuildWatcherPromptOptions {
  contextLines?: number;
  maxPromptBytes?: number;
}

export interface BuiltWatcherPrompt {
  action: "ask" | "edit";
  includedMarkers: ParsedAiMarker[];
  prompt: string;
  truncated: boolean;
}

const DEFAULT_CONTEXT_LINES = 12;
const DEFAULT_MAX_PROMPT_BYTES = 60_000;

const EDIT_INSTRUCTIONS = `You are responding to pi-watcher comments the user added in their editor.
Treat comments marked AI! as targeted code-change requests.
Use read/edit/write tools as needed. Keep changes focused.
After completing requested changes, remove handled AI!, AI?, and AI. comments.
This is a pi-watcher fast-path turn: make the smallest useful edit directly; skip large task workflow unless the marked request clearly requires it.`;

const ASK_INSTRUCTIONS =
  "You are responding to pi-watcher questions the user added in their editor.\n" +
  "Answer the AI? comments. Do not edit files unless a comment explicitly asks for edits.";

function getPromptHeader(action: "ask" | "edit"): string {
  return action === "edit"
    ? `${EDIT_INSTRUCTIONS}\n\nMarked comments:`
    : `${ASK_INSTRUCTIONS}\n\nMarked comments:`;
}

function clampContextLines(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CONTEXT_LINES;
  }

  const resolved = Math.trunc(value);
  if (!Number.isFinite(resolved) || resolved < 0) {
    return DEFAULT_CONTEXT_LINES;
  }

  return resolved;
}

function clampMaxBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_PROMPT_BYTES;
  }

  const resolved = Math.trunc(value);
  if (!Number.isFinite(resolved)) {
    return DEFAULT_MAX_PROMPT_BYTES;
  }

  return Math.max(0, resolved);
}

function inferFenceLanguage(path: string): string {
  const base = path.trim().toLowerCase();
  const dot = base.lastIndexOf(".");
  const extension = dot >= 0 ? base.slice(dot + 1) : "";

  switch (extension) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "ts";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "py":
      return "py";
    default:
      return extension || "text";
  }
}

function pickAction(markers: ParsedAiMarker[]): "ask" | "edit" | null {
  const hasEdit = markers.some((marker) => marker.action === "edit");
  if (hasEdit) {
    return "edit";
  }

  const hasAsk = markers.some((marker) => marker.action === "ask");
  if (hasAsk) {
    return "ask";
  }

  return null;
}

type MarkerWindow = {
  endLine: number;
  markerLines: Set<number>;
  markers: ParsedAiMarker[];
  startLine: number;
};

function toWindows(
  markers: ParsedAiMarker[],
  lines: string[],
  contextLines: number,
): MarkerWindow[] {
  const windows: MarkerWindow[] = [];

  const sorted = [...markers].sort((a, b) => a.line - b.line);
  for (const marker of sorted) {
    windows.push({
      endLine: Math.min(lines.length, marker.block.endLine + contextLines),
      markerLines: new Set([marker.line]),
      markers: [marker],
      startLine: Math.max(1, marker.block.startLine - contextLines),
    });
  }

  windows.sort((a, b) => a.startLine - b.startLine);

  const merged: MarkerWindow[] = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (!previous || window.startLine > previous.endLine + 1) {
      merged.push(window);
      continue;
    }

    previous.endLine = Math.max(previous.endLine, window.endLine);
    for (const markerLine of window.markerLines) {
      previous.markerLines.add(markerLine);
    }
    previous.markers.push(...window.markers);
  }

  return merged;
}

function lineAt(lines: string[], lineNumber: number): string {
  return lines[lineNumber - 1] ?? "";
}

function longestBacktickRun(lines: string[]): number {
  let longest = 0;

  for (const line of lines) {
    const matches = line.match(/`+/g) ?? [];
    for (const match of matches) {
      longest = Math.max(longest, match.length);
    }
  }

  return longest;
}

function fenceFor(
  language: string,
  bodyLines: string[],
): {
  close: string;
  open: string;
} {
  const ticks = "`".repeat(Math.max(3, longestBacktickRun(bodyLines) + 1));
  return {
    close: ticks,
    open: `${ticks}${language}`,
  };
}

function formatSnippet(
  path: string,
  language: string,
  fileLines: string[],
  window: MarkerWindow,
): string {
  const sortedMarkers = [...window.markers].sort((a, b) => a.line - b.line);

  const bodyLines: string[] = [];
  for (
    let lineNumber = window.startLine;
    lineNumber <= window.endLine;
    lineNumber += 1
  ) {
    const glyph = window.markerLines.has(lineNumber) ? "█" : "|";
    bodyLines.push(`${lineNumber} ${glyph} ${lineAt(fileLines, lineNumber)}`);
  }

  const fence = fenceFor(language, bodyLines);
  return [
    ...sortedMarkers.map(
      (marker) => `${path}:${marker.line} action=${marker.action}`,
    ),
    fence.open,
    ...bodyLines,
    fence.close,
  ].join("\n");
}

function summarizeMarker(marker: ParsedAiMarker): string {
  const safeInstruction = marker.instruction
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `- ${marker.path}:${marker.line} action=${marker.action} instruction="${safeInstruction}"`;
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  // `Buffer.subarray(...).toString("utf8")` can emit U+FFFD
  // when it cuts through a multi-byte codepoint.
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= 0; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // Keep shrinking until bytes end on a valid UTF-8 boundary.
    }
  }

  return "";
}

function buildCompactPrompt(summaries: string[], maxBytes: number): string {
  const prefix =
    "Prompt exceeded maxPromptBytes. Using compact marker summaries.";

  if (Buffer.byteLength(prefix, "utf8") >= maxBytes) {
    return truncateToUtf8Bytes(prefix, maxBytes);
  }

  let compact = prefix;
  for (const summary of summaries) {
    const candidate = `${compact}\n${summary}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      compact = candidate;
      continue;
    }

    const remainingBytes = maxBytes - Buffer.byteLength(`${compact}\n`, "utf8");
    const truncatedSummary = truncateToUtf8Bytes(summary, remainingBytes);
    if (truncatedSummary.length > 0) {
      compact = `${compact}\n${truncatedSummary}`;
    }
    break;
  }

  return compact;
}

export function buildWatcherPrompt(
  files: WatcherFileState[],
  options: BuildWatcherPromptOptions = {},
): BuiltWatcherPrompt | null {
  const includedMarkers = files.flatMap((file) => file.markers);
  const action = pickAction(includedMarkers);

  if (action === null) {
    return null;
  }

  const hasActionable = includedMarkers.some(
    (marker) => marker.action !== "context",
  );
  if (!hasActionable) {
    return null;
  }

  const contextLines = clampContextLines(options.contextLines);
  const maxPromptBytes = clampMaxBytes(options.maxPromptBytes);
  const snippets: string[] = [];

  for (const file of files) {
    const fileLines = file.content.split(/\r\n|\n|\r/);
    if (fileLines.length === 0) {
      continue;
    }

    const language = inferFenceLanguage(file.path);
    const windows = toWindows(file.markers, fileLines, contextLines);

    for (const window of windows) {
      snippets.push(formatSnippet(file.path, language, fileLines, window));
    }
  }

  const header = getPromptHeader(action);
  const prompt = snippets.reduce((acc, snippet, index) => {
    return index === 0 ? `${acc}\n${snippet}` : `${acc}\n\n${snippet}`;
  }, header);

  if (Buffer.byteLength(prompt, "utf8") <= maxPromptBytes) {
    return {
      action,
      includedMarkers,
      prompt,
      truncated: false,
    };
  }

  const compactPrompt = buildCompactPrompt(
    includedMarkers.map(summarizeMarker),
    maxPromptBytes,
  );

  return {
    action,
    includedMarkers,
    prompt: compactPrompt,
    truncated: true,
  };
}
