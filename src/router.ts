import type { ParsedAiMarker } from "./parser";
import { type BuildWatcherPromptOptions, buildWatcherPrompt } from "./prompt";
import {
  PI_WATCHER_STATE_ENTRY_TYPE,
  type WatcherBatch,
  type WatcherState,
  clearProcessedMarkerIds,
  clearProcessedMarkers,
  completeInFlightBatch,
  createWatcherState,
  filterBatchForDispatch,
  markBatchInFlight,
} from "./state";

export interface WatcherAgentContext {
  hasPendingMessages: () => boolean;
  isIdle: () => boolean;
}

export type WatcherRouterStatus =
  | "completed"
  | "dispatched"
  | "queued"
  | "suppressed";

export interface WatcherRouterResult {
  status: WatcherRouterStatus;
}

export interface WatcherRouterSnapshot {
  inFlightMarkerCount: number;
  lastBatchMarkerCount: number;
  processedMarkerCount: number;
  queuedMarkerCount: number;
  status: "dispatching" | "queued" | "watching";
}

interface LastCompleted {
  batch: WatcherBatch;
  markerIds: string[];
}

interface QueuedBatch {
  options?: BuildWatcherPromptOptions;
  promptBatch: WatcherBatch;
}

interface WatcherRouterApi {
  appendEntry: <T = unknown>(type: string, data?: T) => void;
  sendUserMessage: (prompt: string) => void;
}

function isActionableMarker(marker: ParsedAiMarker): boolean {
  return marker.action !== "context";
}

function collectActionableMarkers(markers: ParsedAiMarker[]): ParsedAiMarker[] {
  return markers.filter(isActionableMarker);
}

function countActionableMarkers(batch: WatcherBatch): number {
  return batch.files.flatMap((file) => file.markers).filter(isActionableMarker)
    .length;
}

function countQueuedMarkers(queue: QueuedBatch[]): number {
  return queue.reduce(
    (count, { promptBatch }) => count + countActionableMarkers(promptBatch),
    0,
  );
}

function createRouterSnapshot(
  routerStatus: "dispatching" | "queued" | "watching",
  state: WatcherState,
  queue: QueuedBatch[],
  lastDispatchedMarkerCount: number,
): WatcherRouterSnapshot {
  return {
    inFlightMarkerCount: state.inFlight ? state.inFlight.markerIds.length : 0,
    lastBatchMarkerCount: lastDispatchedMarkerCount,
    processedMarkerCount: state.processedMarkerIntentIds.size,
    queuedMarkerCount: countQueuedMarkers(queue),
    status: routerStatus,
  };
}

export class WatcherRouter {
  private readonly pi: WatcherRouterApi;
  private readonly state: WatcherState;
  private lastCompleted: LastCompleted | null = null;
  private lastDispatchedMarkerCount = 0;
  private queue: QueuedBatch[] = [];
  private status: "dispatching" | "queued" | "watching" = "watching";

  constructor(pi: WatcherRouterApi) {
    this.pi = pi;
    this.state = createWatcherState();
  }

  enqueueBatch(
    batch: WatcherBatch,
    context: WatcherAgentContext,
    options?: BuildWatcherPromptOptions,
  ): WatcherRouterResult {
    const filteredBatch = filterBatchForDispatch(this.state, batch);

    if (!filteredBatch) {
      return { status: "suppressed" };
    }

    if (this.isReadyToDispatch(context)) {
      return this.dispatchFilteredBatch(filteredBatch, options);
    }

    this.queue.push({ options, promptBatch: filteredBatch });
    this.status = "queued";
    this.persistSnapshot();

    return { status: "queued" };
  }

  handleAgentEnd(context: WatcherAgentContext): WatcherRouterResult {
    const completed = completeInFlightBatch(this.state);

    if (completed) {
      this.lastCompleted = completed;
    }

    if (this.queue.length > 0) {
      return this.dispatchFromQueue(context);
    }

    this.status = "watching";
    this.persistSnapshot();
    return { status: "completed" };
  }

  retryLast(
    context: WatcherAgentContext,
    options?: BuildWatcherPromptOptions,
  ): WatcherRouterResult {
    if (!this.lastCompleted) {
      return { status: "suppressed" };
    }

    clearProcessedMarkerIds(this.state, this.lastCompleted.markerIds);
    return this.enqueueBatch(this.lastCompleted.batch, context, options);
  }

  clear(): WatcherRouterSnapshot {
    this.queue = [];
    clearProcessedMarkers(this.state);
    this.lastCompleted = null;
    this.lastDispatchedMarkerCount = 0;

    if (!this.state.inFlight) {
      this.status = "watching";
    }

    this.persistSnapshot();
    return this.snapshot();
  }

  getSnapshot(): WatcherRouterSnapshot {
    return this.snapshot();
  }

  private dispatchFilteredBatch(
    batch: WatcherBatch,
    options?: BuildWatcherPromptOptions,
  ): WatcherRouterResult {
    const prompt = buildWatcherPrompt(batch.files, options);
    if (!prompt) {
      return { status: "suppressed" };
    }

    const actionableMarkers = collectActionableMarkers(prompt.includedMarkers);
    markBatchInFlight(this.state, batch, actionableMarkers);
    this.lastDispatchedMarkerCount = actionableMarkers.length;

    this.pi.sendUserMessage(prompt.prompt);
    this.status = "dispatching";
    this.persistSnapshot();

    return { status: "dispatched" };
  }

  private dispatchFromQueue(context: WatcherAgentContext): WatcherRouterResult {
    if (!this.isReadyToDispatch(context)) {
      this.status = "queued";
      this.persistSnapshot();
      return { status: "queued" };
    }

    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }

      const filteredBatch = filterBatchForDispatch(
        this.state,
        next.promptBatch,
      );
      if (!filteredBatch) {
        continue;
      }

      return this.dispatchFilteredBatch(filteredBatch, next.options);
    }

    this.status = "watching";
    this.persistSnapshot();
    return { status: "completed" };
  }

  private isReadyToDispatch(context: WatcherAgentContext): boolean {
    return context.isIdle() && !context.hasPendingMessages();
  }

  private persistSnapshot(): void {
    this.pi.appendEntry(PI_WATCHER_STATE_ENTRY_TYPE, this.snapshot());
  }

  private snapshot(): WatcherRouterSnapshot {
    return createRouterSnapshot(
      this.status,
      this.state,
      this.queue,
      this.lastDispatchedMarkerCount,
    );
  }
}
