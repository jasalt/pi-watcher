import { describe, expect, it } from "vitest";
import { parseAiMarkers } from "../src/parser";
import { WatcherRouter } from "../src/router";
import { PI_WATCHER_STATE_ENTRY_TYPE } from "../src/state";

function batchFor(path: string, content: string) {
  return {
    files: [
      {
        content,
        markers: parseAiMarkers(content, { path }),
        path,
      },
    ],
    reason: "test",
  };
}

function createRouterHarness(
  options: { idle?: boolean; pending?: boolean } = {},
) {
  let idle = options.idle ?? true;
  const pending = options.pending ?? false;
  const sent: string[] = [];
  const entries: Array<{ data: unknown; type: string }> = [];
  const router = new WatcherRouter({
    appendEntry: (type, data) => entries.push({ data, type }),
    sendUserMessage: (prompt) => sent.push(prompt),
  });

  return {
    ctx: {
      hasPendingMessages: () => pending,
      isIdle: () => idle,
    },
    entries,
    router,
    sent,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

describe("WatcherRouter", () => {
  it("dispatches immediately through sendUserMessage when pi is idle", () => {
    const harness = createRouterHarness();
    const batch = batchFor(
      "src/label.ts",
      "// handle null AI!\nexport const label = (value: string | null) => value.trim();",
    );

    const result = harness.router.enqueueBatch(batch, harness.ctx, {
      contextLines: 0,
    });

    expect(result.status).toBe("dispatched");
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toContain("src/label.ts:1 action=edit");
    expect(harness.entries.at(-1)?.type).toBe(PI_WATCHER_STATE_ENTRY_TYPE);
    expect(harness.router.getSnapshot()).toMatchObject({
      inFlightMarkerCount: 1,
      status: "dispatching",
    });
  });

  it("queues while pi is busy and dispatches after agent_settled", () => {
    const harness = createRouterHarness({ idle: false });
    const batch = batchFor("src/job.ts", "// add retries AI!\nrun();");

    expect(harness.router.enqueueBatch(batch, harness.ctx).status).toBe(
      "queued",
    );
    expect(harness.sent).toHaveLength(0);

    harness.setIdle(true);
    expect(harness.router.handleAgentSettled(harness.ctx).status).toBe(
      "dispatched",
    );
    expect(harness.sent).toHaveLength(1);
  });

  it("does not redispatch the same marker after in-flight completion", () => {
    const harness = createRouterHarness();
    const batch = batchFor("src/job.ts", "// add retries AI!\nrun();");

    harness.router.enqueueBatch(batch, harness.ctx);
    expect(harness.router.handleAgentSettled(harness.ctx).status).toBe(
      "completed",
    );
    expect(harness.router.getSnapshot()).toMatchObject({
      processedMarkerCount: 1,
      status: "watching",
    });

    expect(harness.router.enqueueBatch(batch, harness.ctx).status).toBe(
      "suppressed",
    );
    expect(harness.sent).toHaveLength(1);
  });

  it("retry clears the last processed marker and redispatches it", () => {
    const harness = createRouterHarness();
    const batch = batchFor("src/job.ts", "// add retries AI!\nrun();");

    harness.router.enqueueBatch(batch, harness.ctx);
    harness.router.handleAgentSettled(harness.ctx);

    const retry = harness.router.retryLast(harness.ctx, { contextLines: 0 });

    expect(retry.status).toBe("dispatched");
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]).toContain("src/job.ts:1 action=edit");
  });
});
