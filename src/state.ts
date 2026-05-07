import { createHash } from "node:crypto";

import type { ParsedAiMarker } from "./parser";
import type { WatcherFileState } from "./prompt";

export const PI_WATCHER_STATE_ENTRY_TYPE = "pi-watcher-state";
const DEFAULT_LEDGER_LIMIT = 500;

export interface WatcherBatch {
  files: WatcherFileState[];
  reason: string;
}

export interface WatcherState {
  inFlight: {
    batch: WatcherBatch;
    markerIds: string[];
  } | null;
  ledgerLimit: number;
  processedMarkerIntentIds: Set<string>;
  processedMarkerIntentOrder: string[];
}

export interface CompletedWatcherBatch {
  batch: WatcherBatch;
  markerIds: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createMarkerIntentId(marker: ParsedAiMarker): string {
  // [tag:marker_intent_suppression] Suppress actionable comments by normalized
  // comment intent, not line number, so edits around a marker do not loop.
  return sha256(marker.markerIntentInput);
}

export function createMarkerContextId(marker: ParsedAiMarker): string {
  return sha256(marker.markerContextInput);
}

function actionableMarkerIds(markers: ParsedAiMarker[]): string[] {
  return markers
    .filter((marker) => marker.action !== "context")
    .map(createMarkerIntentId);
}

function rememberProcessedMarkerId(
  state: WatcherState,
  markerId: string,
): void {
  if (state.processedMarkerIntentIds.has(markerId)) {
    state.processedMarkerIntentOrder = state.processedMarkerIntentOrder.filter(
      (id) => id !== markerId,
    );
  }

  state.processedMarkerIntentIds.add(markerId);
  state.processedMarkerIntentOrder.push(markerId);

  while (state.processedMarkerIntentOrder.length > state.ledgerLimit) {
    const oldest = state.processedMarkerIntentOrder.shift();
    if (oldest) {
      state.processedMarkerIntentIds.delete(oldest);
    }
  }
}

export function createWatcherState(
  options: { ledgerLimit?: number } = {},
): WatcherState {
  return {
    inFlight: null,
    ledgerLimit: Math.max(
      1,
      Math.trunc(options.ledgerLimit ?? DEFAULT_LEDGER_LIMIT),
    ),
    processedMarkerIntentIds: new Set<string>(),
    processedMarkerIntentOrder: [],
  };
}

export function clearProcessedMarkerIds(
  state: WatcherState,
  markerIds: string[],
): void {
  for (const id of markerIds) {
    state.processedMarkerIntentIds.delete(id);
  }

  state.processedMarkerIntentOrder = state.processedMarkerIntentOrder.filter(
    (id) => !markerIds.includes(id),
  );
}

export function clearProcessedMarkers(state: WatcherState): void {
  state.processedMarkerIntentIds.clear();
  state.processedMarkerIntentOrder = [];
}

export function filterBatchForDispatch(
  state: WatcherState,
  batch: WatcherBatch,
): WatcherBatch | null {
  const inFlightIds = new Set(state.inFlight?.markerIds ?? []);
  const files = batch.files
    .map((file) => {
      const markers = file.markers.filter((marker) => {
        if (marker.action === "context") {
          return true;
        }

        const markerId = createMarkerIntentId(marker);
        return (
          !state.processedMarkerIntentIds.has(markerId) &&
          !inFlightIds.has(markerId)
        );
      });

      return {
        ...file,
        markers,
      };
    })
    .filter((file) => file.markers.length > 0);

  const hasActionable = files.some((file) =>
    file.markers.some((marker) => marker.action !== "context"),
  );

  if (!hasActionable) {
    return null;
  }

  return {
    files,
    reason: batch.reason,
  };
}

export function markBatchInFlight(
  state: WatcherState,
  batch: WatcherBatch,
  markers?: ParsedAiMarker[],
): void {
  const markerIds = actionableMarkerIds(
    markers ?? batch.files.flatMap((file) => file.markers),
  );

  state.inFlight = {
    batch,
    markerIds,
  };
}

export function completeInFlightBatch(
  state: WatcherState,
): CompletedWatcherBatch | null {
  if (!state.inFlight) {
    return null;
  }

  const completed = state.inFlight;
  state.inFlight = null;

  for (const markerId of completed.markerIds) {
    rememberProcessedMarkerId(state, markerId);
  }

  return {
    batch: completed.batch,
    markerIds: [...completed.markerIds],
  };
}
