import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Set up mocks before importing
jest.unstable_mockModule("../../utils/server-helpers.js", () => ({
  getMatrixContext: () => ({
    matrixUserId: "@bot:example.com",
    homeserverUrl: "https://matrix.example.com",
  }),
  getAccessToken: () => "test-token",
  createConfiguredMatrixClient: jest.fn(),
}));

jest.unstable_mockModule("../../matrix/client.js", () => ({
  removeClientFromCache: jest.fn(),
}));

jest.unstable_mockModule("../../utils/matrix-errors.js", () => ({
  shouldEvictClientCache: () => false,
  getDiagnosticHint: () => "Call get-server-health for diagnostics if this persists.",
}));

// Dynamic imports after mocks
const { createConfiguredMatrixClient } = await import("../../utils/server-helpers.js");
const { getThreadMessagesHandler } = await import("./thread-messages.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function mockEvent(opts: {
  id: string; sender: string; body: string; ts: number;
  relType?: string; threadRoot?: string; replyTo?: string;
  encrypted?: boolean; redacted?: boolean; msgtype?: string;
}) {
  return {
    getId: () => opts.id,
    getSender: () => opts.sender,
    getTs: () => opts.ts,
    getType: () => opts.encrypted ? "m.room.encrypted" : "m.room.message",
    getContent: () => ({
      msgtype: opts.msgtype ?? "m.text",
      body: opts.body,
      ...(opts.relType ? {
        "m.relates_to": {
          rel_type: opts.relType,
          event_id: opts.threadRoot,
          ...(opts.replyTo ? { "m.in_reply_to": { event_id: opts.replyTo } } : {}),
        },
      } : {}),
    }),
    getClearContent: () => opts.encrypted ? { body: opts.body, msgtype: "m.text" } : undefined,
    isRedacted: () => opts.redacted ?? false,
  };
}

function mockRootEvent(opts: { id: string; sender: string; body: string; ts: number }) {
  return {
    getId: () => opts.id,
    getSender: () => opts.sender,
    getTs: () => opts.ts,
    getContent: () => ({ msgtype: "m.text", body: opts.body }),
  };
}

describe("getThreadMessagesHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns thread replies sorted oldest first", async () => {
    const events = [
      mockEvent({ id: "$r2", sender: "@bob:ex.com", body: "second", ts: 2000, relType: "io.element.thread", threadRoot: "$root" }),
      mockEvent({ id: "$r1", sender: "@alice:ex.com", body: "first", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: null, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBe(2);
    const first = JSON.parse(result.content[0].text);
    const second = JSON.parse(result.content[1].text);
    expect(first.body).toBe("first");
    expect(second.body).toBe("second");
  });

  it("includes root event on first page only", async () => {
    const root = mockRootEvent({ id: "$root", sender: "@alice:ex.com", body: "thread start", ts: 500 });
    const events = [
      mockEvent({ id: "$r1", sender: "@bob:ex.com", body: "reply", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: root, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(result.content.length).toBe(2);
    const rootMsg = JSON.parse(result.content[0].text);
    expect(rootMsg.isThreadRoot).toBe(true);
    expect(rootMsg.body).toBe("thread start");
  });

  it("excludes root event when paginationToken is provided", async () => {
    const root = mockRootEvent({ id: "$root", sender: "@alice:ex.com", body: "thread start", ts: 500 });
    const events = [
      mockEvent({ id: "$r3", sender: "@bob:ex.com", body: "page 2 reply", ts: 3000, relType: "io.element.thread", threadRoot: "$root" }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: root, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50, paginationToken: "batch_abc" },
      reqContext
    );
    expect(result.content.length).toBe(1);
    const msg = JSON.parse(result.content[0].text);
    expect(msg.isThreadRoot).toBeUndefined();
    expect(msg.body).toBe("page 2 reply");
  });

  it("returns __nextPageToken when nextBatch exists", async () => {
    const events = [
      mockEvent({ id: "$r1", sender: "@alice:ex.com", body: "msg", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: null, nextBatch: "batch_xyz" }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    const lastContent = result.content[result.content.length - 1];
    expect(lastContent.text).toBe("__nextPageToken:batch_xyz");
  });

  it("passes paginationToken as from parameter to relations API", async () => {
    const events = [
      mockEvent({ id: "$r1", sender: "@a:ex.com", body: "msg", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
    ];
    const mockRelations = jest.fn<any>().mockResolvedValue({ events, originalEvent: null, nextBatch: null });
    const client = { relations: mockRelations, getRoom: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 25, paginationToken: "page2_token" },
      reqContext
    );
    // First call should include from parameter
    expect(mockRelations).toHaveBeenCalledWith(
      "!room:ex.com", "$root", "io.element.thread", "m.room.message",
      expect.objectContaining({ from: "page2_token", limit: 25 })
    );
  });

  it("filters out edit events (m.replace)", async () => {
    const events = [
      mockEvent({ id: "$r1", sender: "@a:ex.com", body: "original", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
      mockEvent({ id: "$edit1", sender: "@a:ex.com", body: "edited", ts: 1500, relType: "m.replace", threadRoot: "$r1" }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: null, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(JSON.parse(result.content[0].text).body).toBe("original");
  });

  it("filters out redacted events", async () => {
    const events = [
      mockEvent({ id: "$r1", sender: "@a:ex.com", body: "visible", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
      mockEvent({ id: "$r2", sender: "@b:ex.com", body: "deleted", ts: 2000, relType: "io.element.thread", threadRoot: "$root", redacted: true }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: null, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(JSON.parse(result.content[0].text).body).toBe("visible");
  });

  it("falls back to timeline scan when relations API returns empty", async () => {
    const timelineEvents = [
      mockEvent({ id: "$t1", sender: "@a:ex.com", body: "timeline reply", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
      mockEvent({ id: "$t2", sender: "@b:ex.com", body: "unrelated", ts: 2000 }),
    ];
    const room = {
      getLiveTimeline: () => ({ getEvents: () => timelineEvents }),
    };
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events: [], originalEvent: null, nextBatch: null }),
      getRoom: () => room,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(JSON.parse(result.content[0].text).body).toBe("timeline reply");
  });

  it("skips timeline fallback when paginationToken is provided", async () => {
    const room = {
      getLiveTimeline: () => ({
        getEvents: () => [
          mockEvent({ id: "$t1", sender: "@a:ex.com", body: "timeline msg", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
        ],
      }),
    };
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events: [], originalEvent: null, nextBatch: null }),
      getRoom: () => room,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50, paginationToken: "tok" },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No messages found");
  });

  it("returns 'No messages found' for empty thread", async () => {
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events: [], originalEvent: null, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No messages found");
    expect(result.content[0].text).toContain("$root");
  });

  it("tries m.thread when io.element.thread returns empty", async () => {
    const events = [
      mockEvent({ id: "$r1", sender: "@a:ex.com", body: "found via m.thread", ts: 1000, relType: "m.thread", threadRoot: "$root" }),
    ];
    const mockRelations = jest.fn<any>()
      .mockResolvedValueOnce({ events: [], originalEvent: null, nextBatch: null })
      .mockResolvedValueOnce({ events, originalEvent: null, nextBatch: null });
    const client = { relations: mockRelations, getRoom: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(mockRelations).toHaveBeenCalledTimes(2);
    expect(mockRelations.mock.calls[0][2]).toBe("io.element.thread");
    expect(mockRelations.mock.calls[1][2]).toBe("m.thread");
    expect(result.content.length).toBe(1);
    expect(JSON.parse(result.content[0].text).body).toBe("found via m.thread");
  });

  it("includes replyToEventId when present", async () => {
    const events = [
      mockEvent({
        id: "$r1", sender: "@a:ex.com", body: "replying", ts: 1000,
        relType: "io.element.thread", threadRoot: "$root", replyTo: "$prev",
      }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: null, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    const msg = JSON.parse(result.content[0].text);
    expect(msg.replyToEventId).toBe("$prev");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 50 },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to get thread messages");
    expect(result.content[0].text).toContain("get-server-health");
  });

  it("respects limit parameter", async () => {
    const events = [
      mockEvent({ id: "$r1", sender: "@a:ex.com", body: "one", ts: 1000, relType: "io.element.thread", threadRoot: "$root" }),
      mockEvent({ id: "$r2", sender: "@b:ex.com", body: "two", ts: 2000, relType: "io.element.thread", threadRoot: "$root" }),
      mockEvent({ id: "$r3", sender: "@c:ex.com", body: "three", ts: 3000, relType: "io.element.thread", threadRoot: "$root" }),
    ];
    const client = {
      relations: jest.fn<any>().mockResolvedValue({ events, originalEvent: null, nextBatch: null }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getThreadMessagesHandler(
      { roomId: "!room:ex.com", threadRootEventId: "$root", limit: 2 },
      reqContext
    );
    // Root not included (no originalEvent), so just the 2 limited replies
    expect(result.content.length).toBe(2);
  });
});
