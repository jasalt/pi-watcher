import { describe, expect, it } from "vitest";
import { parseAiMarkers } from "../src/parser";
import {
  clearProcessedMarkerIds,
  completeInFlightBatch,
  createMarkerContextId,
  createMarkerIntentId,
  createWatcherState,
  filterBatchForDispatch,
  markBatchInFlight,
} from "../src/state";

function fileState(path: string, content: string) {
  return {
    content,
    markers: parseAiMarkers(content, { path }),
    path,
  };
}

describe("watcher state", () => {
  it("uses line-shift-stable intent ids and context-sensitive diagnostic ids", () => {
    // [ref:marker_intent_suppression]
    const markerA = parseAiMarkers("// fix thing AI!\nconst x = 1;", {
      path: "src/foo.ts",
    })[0];
    const markerB = parseAiMarkers("\n\n// fix thing AI!\nconst x = 2;", {
      path: "src/foo.ts",
    })[0];

    expect(createMarkerIntentId(markerB)).toBe(createMarkerIntentId(markerA));
    expect(createMarkerContextId(markerB)).not.toBe(
      createMarkerContextId(markerA),
    );
  });

  it("suppresses completed actionable markers until retry clears them", () => {
    const state = createWatcherState();
    const batch = {
      files: [
        fileState("src/task.ts", "// update branch AI!\nexport const x = 1;"),
      ],
      reason: "test",
    };

    const firstDispatch = filterBatchForDispatch(state, batch);
    expect(firstDispatch?.files[0]?.markers).toHaveLength(1);

    markBatchInFlight(
      state,
      firstDispatch ?? batch,
      firstDispatch?.files[0]?.markers ?? [],
    );
    const completed = completeInFlightBatch(state);

    expect(completed?.markerIds).toEqual([
      createMarkerIntentId(batch.files[0].markers[0]),
    ]);
    expect(filterBatchForDispatch(state, batch)).toBeNull();

    clearProcessedMarkerIds(state, completed?.markerIds ?? []);
    expect(
      filterBatchForDispatch(state, batch)?.files[0]?.markers,
    ).toHaveLength(1);
  });
});
