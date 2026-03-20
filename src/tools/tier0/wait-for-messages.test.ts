import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { EventEmitter } from "events";

jest.unstable_mockModule("../../matrix/messageQueue.js", () => ({
  getMessageQueue: jest.fn(),
}));

jest.unstable_mockModule("../../utils/matrix-errors.js", () => ({
  getDiagnosticHint: () => "Call get-server-health for diagnostics if this persists.",
}));

const { getMessageQueue } = await import("../../matrix/messageQueue.js");
const { waitForMessagesHandler, formatResponse } = await import("./wait-for-messages.js");

const mockGetMessageQueue = getMessageQueue as jest.MockedFunction<typeof getMessageQueue>;

function createMockQueue(
  peekResult = { count: 0, types: { messages: 0, reactions: 0, invites: 0 }, rooms: [] as any[] }
) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    peek: jest.fn().mockReturnValue(peekResult),
    peekRoom: jest.fn().mockReturnValue(peekResult),
  });
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe("formatResponse", () => {
  it("returns MCP content with JSON-serialized status and peek data", () => {
    const peek = {
      count: 3,
      types: { messages: 2, reactions: 1, invites: 0 },
      rooms: [{ roomId: "!abc:x", roomName: "General", count: 3 }],
    };
    const result = formatResponse("messages_available", peek);
    const parsed = parseResult(result);

    expect(parsed.status).toBe("messages_available");
    expect(parsed.count).toBe(3);
    expect(parsed.types).toEqual({ messages: 2, reactions: 1, invites: 0 });
    expect(parsed.rooms).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });
});

describe("waitForMessagesHandler", () => {
  let mockQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    mockQueue = createMockQueue();
    mockGetMessageQueue.mockReturnValue(mockQueue as any);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns immediately with messages_available when queue already has items", async () => {
    const peek = { count: 5, types: { messages: 3, reactions: 1, invites: 1 }, rooms: [] as any[] };
    mockQueue.peek.mockReturnValue(peek);

    const result = await waitForMessagesHandler({ timeoutMs: 5000 }, {});
    const parsed = parseResult(result);

    expect(parsed.status).toBe("messages_available");
    expect(parsed.count).toBe(5);
    expect(mockQueue.peek).toHaveBeenCalled();
  });

  it("returns timeout with zero counts when no messages arrive within timeout", async () => {
    jest.useFakeTimers();

    const promise = waitForMessagesHandler({ timeoutMs: 5000 }, {});
    jest.advanceTimersByTime(5000);
    const result = await promise;
    const parsed = parseResult(result);

    expect(parsed.status).toBe("timeout");
    expect(parsed.count).toBe(0);
    expect(parsed.types).toEqual({ messages: 0, reactions: 0, invites: 0 });

    jest.useRealTimers();
  });

  it("returns messages_available when new-item event fires during wait", async () => {
    jest.useFakeTimers();

    const afterPeek = { count: 2, types: { messages: 2, reactions: 0, invites: 0 }, rooms: [] as any[] };

    const promise = waitForMessagesHandler({ timeoutMs: 30000 }, {});

    // After the event fires, the handler peeks again — return items on second call
    mockQueue.peek.mockReturnValue(afterPeek);
    mockQueue.emit("new-item", { roomId: "!room:x" });

    const result = await promise;
    const parsed = parseResult(result);

    expect(parsed.status).toBe("messages_available");
    expect(parsed.count).toBe(2);

    jest.useRealTimers();
  });

  it("returns aborted when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await waitForMessagesHandler({ timeoutMs: 5000 }, { signal: controller.signal });
    const parsed = parseResult(result);

    expect(parsed.status).toBe("aborted");
  });

  it("respects roomId filter — calls peekRoom instead of peek", async () => {
    const roomPeek = { count: 1, types: { messages: 1, reactions: 0, invites: 0 }, rooms: [] as any[] };
    mockQueue.peekRoom.mockReturnValue(roomPeek);

    const result = await waitForMessagesHandler({ roomId: "!myroom:x", timeoutMs: 5000 }, {});
    const parsed = parseResult(result);

    expect(parsed.status).toBe("messages_available");
    expect(parsed.count).toBe(1);
    expect(mockQueue.peekRoom).toHaveBeenCalledWith("!myroom:x");
    expect(mockQueue.peek).not.toHaveBeenCalled();
  });

  it("clamps timeout to [1000, 300000] range", async () => {
    jest.useFakeTimers();

    // Test lower bound: 100ms should be clamped to 1000ms
    const promise1 = waitForMessagesHandler({ timeoutMs: 100 }, {});
    // Advance 999ms — should NOT have timed out yet
    jest.advanceTimersByTime(999);
    // Now advance 1ms more to reach the clamped 1000ms
    jest.advanceTimersByTime(1);
    const result1 = await promise1;
    expect(parseResult(result1).status).toBe("timeout");

    // Test upper bound: 600000ms should be clamped to 300000ms
    const promise2 = waitForMessagesHandler({ timeoutMs: 600000 }, {});
    jest.advanceTimersByTime(300000);
    const result2 = await promise2;
    expect(parseResult(result2).status).toBe("timeout");

    jest.useRealTimers();
  });

  it("filters room-specific new-item events — events for other rooms do not resolve", async () => {
    jest.useFakeTimers();

    const promise = waitForMessagesHandler({ roomId: "!target:x", timeoutMs: 5000 }, {});

    // Emit event for a different room — should be ignored
    mockQueue.emit("new-item", { roomId: "!other:x" });

    // Should still be pending, advance to timeout
    jest.advanceTimersByTime(5000);
    const result = await promise;
    const parsed = parseResult(result);

    expect(parsed.status).toBe("timeout");

    jest.useRealTimers();
  });

  it("resolves when event matches the watched room", async () => {
    jest.useFakeTimers();

    const afterPeek = { count: 1, types: { messages: 1, reactions: 0, invites: 0 }, rooms: [] as any[] };

    const promise = waitForMessagesHandler({ roomId: "!target:x", timeoutMs: 30000 }, {});

    // Emit for wrong room first — ignored
    mockQueue.emit("new-item", { roomId: "!wrong:x" });
    // Emit for correct room — resolves
    mockQueue.peekRoom.mockReturnValue(afterPeek);
    mockQueue.emit("new-item", { roomId: "!target:x" });

    const result = await promise;
    const parsed = parseResult(result);

    expect(parsed.status).toBe("messages_available");
    expect(mockQueue.peekRoom).toHaveBeenCalledWith("!target:x");

    jest.useRealTimers();
  });

  it("wraps errors with getDiagnosticHint", async () => {
    mockGetMessageQueue.mockImplementation(() => {
      throw new Error("Queue not initialized");
    });

    const result = await waitForMessagesHandler({ timeoutMs: 5000 }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Queue not initialized");
    expect(result.content[0].text).toContain("Call get-server-health for diagnostics if this persists.");
  });

  it("returns aborted when signal fires during wait", async () => {
    jest.useFakeTimers();

    const controller = new AbortController();
    const promise = waitForMessagesHandler({ timeoutMs: 30000 }, { signal: controller.signal });

    // Abort during the wait
    controller.abort();

    const result = await promise;
    const parsed = parseResult(result);

    expect(parsed.status).toBe("aborted");

    jest.useRealTimers();
  });
});
