import { describe, expect, it } from "vitest";
import { parseAiMarkers } from "../src/parser";
import { buildWatcherPrompt } from "../src/prompt";

function promptFor(
  path: string,
  content: string,
  options: { contextLines?: number; maxPromptBytes?: number } = {},
) {
  return buildWatcherPrompt(
    [
      {
        content,
        markers: parseAiMarkers(content, { path }),
        path,
      },
    ],
    options,
  );
}

describe("buildWatcherPrompt", () => {
  it("builds an edit prompt with focused marked snippets", () => {
    const content = [
      "export function label(input: string | null) {",
      "  // handle null safely AI!",
      "  return input.trim();",
      "}",
    ].join("\n");

    const result = promptFor("src/label.ts", content, { contextLines: 1 });

    expect(result?.action).toBe("edit");
    expect(result?.truncated).toBe(false);
    expect(result?.prompt).toMatchInlineSnapshot(`
      "You are responding to pi-watcher comments the user added in their editor.
      Treat comments marked AI! as targeted code-change requests.
      Use read/edit/write tools as needed. Keep changes focused.
      After completing requested changes, remove handled AI!, AI?, and AI. comments.
      This is a pi-watcher fast-path turn: make the smallest useful edit directly; skip large task workflow unless the marked request clearly requires it.

      Marked comments:
      src/label.ts:2 action=edit
      \`\`\`ts
      1 | export function label(input: string | null) {
      2 █   // handle null safely AI!
      3 |   return input.trim();
      \`\`\`"
    `);
  });

  it("builds an ask prompt that discourages edits", () => {
    const content = [
      "def total(values):",
      "    # why not use sum here AI?",
      "    result = 0",
      "    for value in values:",
      "        result += value",
      "    return result",
    ].join("\n");

    const result = promptFor("pkg/math.py", content, { contextLines: 1 });

    expect(result?.action).toBe("ask");
    expect(result?.prompt).toMatchInlineSnapshot(`
      "You are responding to pi-watcher questions the user added in their editor.
      Answer the AI? comments. Do not edit files unless a comment explicitly asks for edits.

      Marked comments:
      pkg/math.py:2 action=ask
      \`\`\`py
      1 | def total(values):
      2 █     # why not use sum here AI?
      3 |     result = 0
      \`\`\`"
    `);
  });

  it("includes AI. anchors with the next actionable batch", () => {
    const anchorContent = [
      "export const MAX_RETRIES = 3;",
      "// keep retry budget in mind AI.",
    ].join("\n");
    const actionContent = [
      'import { MAX_RETRIES } from "./config";',
      "export async function request() {",
      "  // add backoff AI!",
      '  return fetch("/api");',
      "}",
    ].join("\n");

    const result = buildWatcherPrompt(
      [
        {
          content: anchorContent,
          markers: parseAiMarkers(anchorContent, { path: "src/config.ts" }),
          path: "src/config.ts",
        },
        {
          content: actionContent,
          markers: parseAiMarkers(actionContent, { path: "src/request.ts" }),
          path: "src/request.ts",
        },
      ],
      { contextLines: 1 },
    );

    expect(result?.action).toBe("edit");
    expect(result?.includedMarkers.map((marker) => marker.action)).toEqual([
      "context",
      "edit",
    ]);
    expect(result?.prompt).toMatchInlineSnapshot(`
      "You are responding to pi-watcher comments the user added in their editor.
      Treat comments marked AI! as targeted code-change requests.
      Use read/edit/write tools as needed. Keep changes focused.
      After completing requested changes, remove handled AI!, AI?, and AI. comments.
      This is a pi-watcher fast-path turn: make the smallest useful edit directly; skip large task workflow unless the marked request clearly requires it.

      Marked comments:
      src/config.ts:2 action=context
      \`\`\`ts
      1 | export const MAX_RETRIES = 3;
      2 █ // keep retry budget in mind AI.
      \`\`\`

      src/request.ts:3 action=edit
      \`\`\`ts
      2 | export async function request() {
      3 █   // add backoff AI!
      4 |   return fetch(\"/api\");
      \`\`\`"
    `);
  });

  it("falls back to compact marker summaries when the prompt is capped", () => {
    const longLine = `const payload = "${"x".repeat(1_000)}";`;
    const content = [
      longLine,
      "// rewrite without huge literal AI!",
      longLine,
    ].join("\n");

    const result = promptFor("src/huge.ts", content, {
      contextLines: 1,
      maxPromptBytes: 420,
    });

    expect(result).not.toBeNull();
    expect(result?.truncated).toBe(true);
    expect(Buffer.byteLength(result?.prompt ?? "", "utf8")).toBeLessThanOrEqual(
      420,
    );
    expect(result?.prompt).toContain("Prompt exceeded maxPromptBytes");
    expect(result?.prompt).toContain(
      '- src/huge.ts:2 action=edit instruction="rewrite without huge literal AI!"',
    );
    expect(result?.prompt).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });

  it("returns null for context-only markers", () => {
    const content = "// remember this helper AI.\nexport const x = 1;";

    expect(promptFor("src/context.ts", content)).toBeNull();
  });
});
