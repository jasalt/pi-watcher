import { describe, expect, it } from "vitest";
import { parseAiMarkers } from "../src/parser";

describe("parseAiMarkers", () => {
  it("parses aider-compatible Python, JS, and Lisp-style markers", () => {
    const source = [
      "def py():",
      "    # fix auth flow AI!",
      "const js = 1; // what happens here ai?",
      ";;; keep this helper AI",
    ].join("\n");

    expect(parseAiMarkers(source, { path: "mixed.txt" })).toMatchObject([
      {
        action: "edit",
        commentPrefix: "#",
        line: 2,
        markerText: "AI!",
        path: "mixed.txt",
      },
      {
        action: "ask",
        commentPrefix: "//",
        line: 3,
        markerText: "ai?",
        path: "mixed.txt",
      },
      {
        action: "context",
        commentPrefix: ";;;",
        line: 4,
        markerText: "AI",
        path: "mixed.txt",
      },
    ]);
  });

  it("supports marker at comment start or comment end", () => {
    const source = [
      "# ai! rewrite this",
      "value = compute() # rewrite this AI!",
    ].join("\n");

    const markers = parseAiMarkers(source, { path: "start-end.py" });

    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => marker.instruction)).toEqual([
      "ai! rewrite this",
      "rewrite this AI!",
    ]);
  });

  it("extracts contiguous instruction blocks with the same comment prefix", () => {
    const source = [
      "function f() {",
      "  // explain constraints",
      "  // update this branch AI!",
      "  // keep null-safe",
      "  return null;",
      "}",
    ].join("\n");

    expect(parseAiMarkers(source, { path: "block.ts" })[0]).toMatchObject({
      block: {
        endLine: 4,
        lines: [
          "explain constraints",
          "update this branch AI!",
          "keep null-safe",
        ],
        startLine: 2,
      },
      normalizedBlock:
        "explain constraints\nupdate this branch ai!\nkeep null-safe",
    });
  });

  it("does not match OpenAI, strings, or non-comment lines", () => {
    const source = [
      "const brand = 'OpenAI';",
      "const fake = '// ai!';",
      'print("# ai?")',
      "not a comment ai!",
      "# mention AI in middle only",
      "# real marker AI?",
    ].join("\n");

    expect(
      parseAiMarkers(source, { path: "false-positives.ts" }),
    ).toMatchObject([
      {
        action: "ask",
        line: 6,
        markerText: "AI?",
      },
    ]);
  });

  it("returns normalized id inputs stable across line shifts", () => {
    const sourceA = "// fix thing AI!\nconst x = 1;";
    const sourceB = "\n\n// fix thing AI!\nconst x = 1;";

    const markerA = parseAiMarkers(sourceA, { path: "src/foo.ts" })[0];
    const markerB = parseAiMarkers(sourceB, { path: "src/foo.ts" })[0];

    expect(markerA.markerIntentInput).toBe("src/foo.ts\nfix thing ai!");
    expect(markerB.markerIntentInput).toBe(markerA.markerIntentInput);
    expect(markerA.markerContextInput).toBe(
      "src/foo.ts\nfix thing ai!\n// fix thing AI!\nconst x = 1;",
    );
  });
});
