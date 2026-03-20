import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Set up mocks before importing
jest.unstable_mockModule("../../matrix/pipelineMetrics.js", () => ({
  getMetrics: jest.fn(),
}));

jest.unstable_mockModule("../../matrix/messageQueue.js", () => ({
  getMessageQueue: jest.fn(),
}));

jest.unstable_mockModule("../../matrix/autoSync.js", () => ({
  isAutoSyncRunning: jest.fn(),
  getAutoSyncState: jest.fn(),
  getSyncHealth: jest.fn(),
}));

jest.unstable_mockModule("../../matrix/e2eeStatus.js", () => ({
  getPhase2Status: jest.fn(),
}));

jest.unstable_mockModule("../../matrix/clientCache.js", () => ({
  getCacheStats: jest.fn(),
}));

jest.unstable_mockModule("../../utils/server-helpers.js", () => ({
  getMatrixContext: jest.fn(),
}));

// Dynamic imports after mocks
const { getMetrics } = await import("../../matrix/pipelineMetrics.js");
const { getMessageQueue } = await import("../../matrix/messageQueue.js");
const { isAutoSyncRunning, getAutoSyncState, getSyncHealth } = await import("../../matrix/autoSync.js");
const { getPhase2Status } = await import("../../matrix/e2eeStatus.js");
const { getCacheStats } = await import("../../matrix/clientCache.js");
const { getMatrixContext } = await import("../../utils/server-helpers.js");
const { restartServerHandler, getPipelineMetricsHandler, getServerHealthHandler } = await import("./server-admin.js");

const mockGetMetrics = getMetrics as jest.MockedFunction<typeof getMetrics>;
const mockGetMessageQueue = getMessageQueue as jest.MockedFunction<typeof getMessageQueue>;
const mockIsAutoSyncRunning = isAutoSyncRunning as jest.MockedFunction<typeof isAutoSyncRunning>;
const mockGetAutoSyncState = getAutoSyncState as jest.MockedFunction<typeof getAutoSyncState>;
const mockGetSyncHealth = getSyncHealth as jest.MockedFunction<typeof getSyncHealth>;
const mockGetPhase2Status = getPhase2Status as jest.MockedFunction<typeof getPhase2Status>;
const mockGetCacheStats = getCacheStats as jest.MockedFunction<typeof getCacheStats>;
const mockGetMatrixContext = getMatrixContext as jest.MockedFunction<typeof getMatrixContext>;

function defaultMetrics(overrides?: Partial<ReturnType<typeof getMetrics>>) {
  return {
    eventsReceived: 100,
    messagesEnqueued: 80,
    messagesFiltered: 15,
    messagesDeduplicated: 5,
    reactionsEnqueued: 10,
    editsProcessed: 3,
    listenerErrors: 0,
    firstEventAt: Date.now() - 60000,
    lastEventAt: Date.now() - 5000,
    ...overrides,
  };
}

function defaultQueuePeek() {
  return {
    count: 3,
    types: { messages: 2, reactions: 1, invites: 0 },
    items: [],
  };
}

function defaultSyncHealth(overrides?: any) {
  return {
    stale: false,
    consecutiveUnhealthy: 0,
    totalReconnects: 0,
    lastReconnectSecondsAgo: null,
    ...overrides,
  };
}

describe("restartServerHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns restart message and schedules exit", async () => {
    const mockSetTimeout = jest.spyOn(global, "setTimeout").mockImplementation((() => {}) as any);
    const result = await restartServerHandler();
    expect(result.content[0].text).toContain("Restarting Matrix MCP server");
    expect(mockSetTimeout).toHaveBeenCalledWith(expect.any(Function), 200);
    mockSetTimeout.mockRestore();
  });
});

describe("getPipelineMetricsHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns formatted pipeline metrics", async () => {
    mockGetMetrics.mockReturnValue(defaultMetrics() as any);
    mockGetMessageQueue.mockReturnValue({ peek: () => defaultQueuePeek() } as any);

    const result = await getPipelineMetricsHandler();
    const text = result.content[0].text;
    expect(text).toContain("Pipeline Metrics");
    expect(text).toContain("Events received:      100");
    expect(text).toContain("Messages enqueued:    80");
    expect(text).toContain("Messages filtered:    15");
    expect(text).toContain("Reactions enqueued:   10");
    expect(text).toContain("Listener errors:     0");
    expect(text).toContain("Pending messages:    2");
    expect(text).toContain("Pending reactions:   1");
    expect(text).toContain("Pending invites:     0");
  });

  it("shows last event time when available", async () => {
    mockGetMetrics.mockReturnValue(defaultMetrics({ lastEventAt: Date.now() - 10000 }) as any);
    mockGetMessageQueue.mockReturnValue({ peek: () => defaultQueuePeek() } as any);

    const result = await getPipelineMetricsHandler();
    expect(result.content[0].text).toContain("Last event:");
    expect(result.content[0].text).toContain("s ago");
  });

  it("omits last event when no events received", async () => {
    mockGetMetrics.mockReturnValue(defaultMetrics({ firstEventAt: 0, lastEventAt: 0 }) as any);
    mockGetMessageQueue.mockReturnValue({ peek: () => defaultQueuePeek() } as any);

    const result = await getPipelineMetricsHandler();
    expect(result.content[0].text).toContain("uptime: 0s");
    expect(result.content[0].text).not.toContain("Last event:");
  });
});

describe("getServerHealthHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  function setupHealthyMocks() {
    mockIsAutoSyncRunning.mockReturnValue(true);
    mockGetAutoSyncState.mockReturnValue("SYNCING" as any);
    mockGetSyncHealth.mockReturnValue(defaultSyncHealth());
    mockGetMatrixContext.mockReturnValue({
      matrixUserId: "@bot:ex.com",
      homeserverUrl: "https://matrix.ex.com",
    } as any);
    mockGetPhase2Status.mockReturnValue({
      state: "completed",
      startedAt: Date.now() - 30000,
      completedAt: Date.now() - 25000,
    } as any);
    mockGetMessageQueue.mockReturnValue({ peek: () => defaultQueuePeek() } as any);
    mockGetMetrics.mockReturnValue(defaultMetrics() as any);
    mockGetCacheStats.mockReturnValue({ size: 2 } as any);
  }

  it("returns healthy status when sync is running and not stale", async () => {
    setupHealthyMocks();

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.status).toBe("healthy");
    expect(health.sync.running).toBe(true);
    expect(health.sync.state).toBe("SYNCING");
    expect(health.sync.stale).toBe(false);
  });

  it("returns degraded status when sync is not running", async () => {
    setupHealthyMocks();
    mockIsAutoSyncRunning.mockReturnValue(false);

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.status).toBe("degraded");
    expect(health.sync.running).toBe(false);
  });

  it("returns degraded status when sync is stale", async () => {
    setupHealthyMocks();
    mockGetSyncHealth.mockReturnValue(defaultSyncHealth({ stale: true, consecutiveUnhealthy: 3 }));

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.status).toBe("degraded");
    expect(health.sync.stale).toBe(true);
    expect(health.sync.consecutiveUnhealthy).toBe(3);
  });

  it("returns degraded when sync state is not SYNCING", async () => {
    setupHealthyMocks();
    mockGetAutoSyncState.mockReturnValue("STOPPED" as any);

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.status).toBe("degraded");
  });

  it("includes E2EE status with phase2 details", async () => {
    setupHealthyMocks();

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.e2ee.userId).toBe("@bot:ex.com");
    expect(health.e2ee.phase2State).toBe("completed");
    expect(health.e2ee.completedAt).toBeDefined();
  });

  it("includes E2EE error when phase2 has error", async () => {
    setupHealthyMocks();
    mockGetPhase2Status.mockReturnValue({
      state: "error",
      error: "OTK mismatch",
      retryCount: 3,
      startedAt: Date.now() - 60000,
    } as any);

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.e2ee.phase2State).toBe("error");
    expect(health.e2ee.error).toBe("OTK mismatch");
    expect(health.e2ee.retryCount).toBe(3);
  });

  it("handles missing matrix context gracefully", async () => {
    setupHealthyMocks();
    mockGetMatrixContext.mockImplementation(() => { throw new Error("not configured"); });

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.e2ee.error).toBe("Matrix context not configured");
  });

  it("includes queue state", async () => {
    setupHealthyMocks();

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.queue.pending).toBe(3);
    expect(health.queue.messages).toBe(2);
    expect(health.queue.reactions).toBe(1);
    expect(health.queue.invites).toBe(0);
  });

  it("includes pipeline stats", async () => {
    setupHealthyMocks();

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.pipeline.eventsReceived).toBe(100);
    expect(health.pipeline.messagesEnqueued).toBe(80);
    expect(health.pipeline.listenerErrors).toBe(0);
    expect(health.pipeline.lastEventSecondsAgo).toBeGreaterThanOrEqual(0);
  });

  it("includes client cache stats", async () => {
    setupHealthyMocks();

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.clientCache.activeClients).toBe(2);
  });

  it("includes process info", async () => {
    setupHealthyMocks();

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.process.heapUsedMB).toBeGreaterThan(0);
    expect(health.process.rssMB).toBeGreaterThan(0);
  });

  it("includes reconnect info when available", async () => {
    setupHealthyMocks();
    mockGetSyncHealth.mockReturnValue(defaultSyncHealth({
      totalReconnects: 2,
      lastReconnectSecondsAgo: 120,
    }));

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.sync.totalReconnects).toBe(2);
    expect(health.sync.lastReconnectSecondsAgo).toBe(120);
  });

  it("returns null lastEventSecondsAgo when no events received", async () => {
    setupHealthyMocks();
    mockGetMetrics.mockReturnValue(defaultMetrics({ firstEventAt: 0, lastEventAt: 0 }) as any);

    const result = await getServerHealthHandler();
    const health = JSON.parse(result.content[0].text);
    expect(health.pipeline.lastEventSecondsAgo).toBeNull();
  });
});
