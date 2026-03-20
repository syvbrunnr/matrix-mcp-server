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

jest.unstable_mockModule("../../matrix/messageProcessor.js", () => ({
  processMessage: jest.fn<any>().mockResolvedValue({ type: "text", text: '{"sender":"@alice:ex.com","body":"hello"}' }),
  processMessagesByDate: jest.fn<any>().mockResolvedValue([]),
  countMessagesByUser: jest.fn<any>().mockReturnValue([]),
}));

jest.unstable_mockModule("../../utils/read-receipt.js", () => ({
  sendReadReceipt: jest.fn<any>().mockResolvedValue(undefined),
}));

// Dynamic imports after mocks
const { createConfiguredMatrixClient } = await import("../../utils/server-helpers.js");
const { processMessage, processMessagesByDate, countMessagesByUser } = await import("../../matrix/messageProcessor.js");
const { getRoomMessagesHandler, getMessagesByDateHandler, identifyActiveUsersHandler } = await import("./messages.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const mockProcessMessage = processMessage as jest.MockedFunction<typeof processMessage>;
const mockProcessByDate = processMessagesByDate as jest.MockedFunction<typeof processMessagesByDate>;
const mockCountByUser = countMessagesByUser as jest.MockedFunction<typeof countMessagesByUser>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function mockRoom(name: string = "Test Room") {
  return {
    name,
    roomId: "!room:ex.com",
    getLiveTimeline: () => ({
      getEvents: () => [
        { getId: () => "$e1", getType: () => "m.room.message" },
        { getId: () => "$e2", getType: () => "m.room.message" },
        { getId: () => "$e3", getType: () => "m.room.message" },
      ],
      getPaginationToken: () => null,
    }),
  };
}

describe("getRoomMessagesHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns processed messages from room timeline", async () => {
    const room = mockRoom();
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: '{"sender":"@alice:ex.com","body":"hello"}' } as any);

    const result = await getRoomMessagesHandler({ roomId: "!room:ex.com", limit: 20 }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(mockProcessMessage).toHaveBeenCalledTimes(3);
  });

  it("respects limit parameter", async () => {
    const room = mockRoom();
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: "msg" } as any);

    await getRoomMessagesHandler({ roomId: "!room:ex.com", limit: 2 }, reqContext);
    expect(mockProcessMessage).toHaveBeenCalledTimes(2);
  });

  it("filters out null messages", async () => {
    const room = mockRoom();
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage
      .mockResolvedValueOnce({ type: "text", text: "valid" } as any)
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ type: "text", text: "also valid" } as any);

    const result = await getRoomMessagesHandler({ roomId: "!room:ex.com", limit: 20 }, reqContext);
    expect(result.content).toHaveLength(2);
  });

  it("returns 'no messages' for empty room", async () => {
    const room = {
      name: "Empty Room",
      roomId: "!empty:ex.com",
      getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => null }),
    };
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomMessagesHandler({ roomId: "!empty:ex.com", limit: 20 }, reqContext);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("No messages found");
    expect(result.content[0].text).toContain("Empty Room");
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomMessagesHandler({ roomId: "!missing:ex.com", limit: 20 }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await getRoomMessagesHandler({ roomId: "!room:ex.com", limit: 20 }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });

  it("includes nextPageToken when backward pagination token exists", async () => {
    const room = {
      name: "Test Room",
      roomId: "!room:ex.com",
      getLiveTimeline: () => ({
        getEvents: () => [
          { getId: () => "$e1", getType: () => "m.room.message" },
        ],
        getPaginationToken: () => "t123_backward",
      }),
    };
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: "msg" } as any);

    const result = await getRoomMessagesHandler({ roomId: "!room:ex.com", limit: 20 }, reqContext);
    expect(result.isError).toBeUndefined();
    const lastContent = result.content[result.content.length - 1];
    expect(lastContent.text).toBe("__nextPageToken:t123_backward");
  });

  it("fetches from server API when paginationToken provided", async () => {
    const room = { name: "Test Room", roomId: "!room:ex.com" };
    const mockCreateMessagesRequest = jest.fn<any>().mockResolvedValue({
      chunk: [
        { event_id: "$old1", type: "m.room.message", sender: "@alice:ex.com", content: { body: "old msg" }, origin_server_ts: 1000 },
      ],
      end: "t456_next",
    });
    const client = { getRoom: () => room, createMessagesRequest: mockCreateMessagesRequest };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: '{"body":"old msg"}' } as any);

    const result = await getRoomMessagesHandler(
      { roomId: "!room:ex.com", limit: 20, paginationToken: "t123_start" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(mockCreateMessagesRequest).toHaveBeenCalledWith("!room:ex.com", "t123_start", 20, "b");
    const lastContent = result.content[result.content.length - 1];
    expect(lastContent.text).toBe("__nextPageToken:t456_next");
  });

  it("returns no nextPageToken when server response has no end token", async () => {
    const room = { name: "Test Room", roomId: "!room:ex.com" };
    const mockCreateMessagesRequest = jest.fn<any>().mockResolvedValue({
      chunk: [
        { event_id: "$old1", type: "m.room.message", sender: "@alice:ex.com", content: { body: "msg" }, origin_server_ts: 1000 },
      ],
    });
    const client = { getRoom: () => room, createMessagesRequest: mockCreateMessagesRequest };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: "msg" } as any);

    const result = await getRoomMessagesHandler(
      { roomId: "!room:ex.com", limit: 10, paginationToken: "t_token" },
      reqContext
    );
    expect(result.content.every((c: any) => !c.text?.startsWith("__nextPageToken:"))).toBe(true);
  });
});

describe("getMessagesByDateHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns messages filtered by date range", async () => {
    const room = mockRoom();
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessByDate.mockResolvedValue([
      { type: "text", text: '{"sender":"@alice:ex.com","body":"in range"}' },
    ] as any);

    const result = await getMessagesByDateHandler(
      { roomId: "!room:ex.com", startDate: "2024-01-01T00:00:00Z", endDate: "2024-01-02T00:00:00Z", limit: 50 },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    // 1 message + no pagination token (mockRoom returns null for getPaginationToken)
    expect(result.content).toHaveLength(1);
    expect(mockProcessByDate).toHaveBeenCalledWith(
      expect.any(Array),
      "2024-01-01T00:00:00Z",
      "2024-01-02T00:00:00Z",
      expect.anything()
    );
  });

  it("returns 'no messages' when date range has no matches", async () => {
    const room = mockRoom("Quiet Room");
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessByDate.mockResolvedValue([] as any);

    const result = await getMessagesByDateHandler(
      { roomId: "!room:ex.com", startDate: "2020-01-01T00:00:00Z", endDate: "2020-01-02T00:00:00Z", limit: 50 },
      reqContext
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("No messages found");
    expect(result.content[0].text).toContain("Quiet Room");
    expect(result.content[0].text).toContain("2020-01-01");
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getMessagesByDateHandler(
      { roomId: "!missing:ex.com", startDate: "2024-01-01T00:00:00Z", endDate: "2024-01-02T00:00:00Z", limit: 50 },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("timeout"));

    const result = await getMessagesByDateHandler(
      { roomId: "!room:ex.com", startDate: "2024-01-01T00:00:00Z", endDate: "2024-01-02T00:00:00Z", limit: 50 },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });

  it("fetches from server API with date filtering when paginationToken provided", async () => {
    const room = { name: "Test Room", roomId: "!room:ex.com" };
    const startDate = "2024-01-01T00:00:00Z";
    const endDate = "2024-01-02T00:00:00Z";
    const startMs = new Date(startDate).getTime();
    const inRangeTs = startMs + 3600_000; // 1h after start
    const mockCreateMessagesRequest = jest.fn<any>().mockResolvedValue({
      chunk: [
        { event_id: "$m1", type: "m.room.message", sender: "@a:ex.com", content: { body: "in range" }, origin_server_ts: inRangeTs },
        { event_id: "$m2", type: "m.room.message", sender: "@b:ex.com", content: { body: "too old" }, origin_server_ts: startMs - 86400_000 },
      ],
      end: "t_next",
    });
    const client = { getRoom: () => room, createMessagesRequest: mockCreateMessagesRequest };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: '{"body":"in range"}' } as any);

    const result = await getMessagesByDateHandler(
      { roomId: "!room:ex.com", startDate, endDate, limit: 50, paginationToken: "t_start" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    // Only 1 message in range + no nextPageToken (oldest event is before startDate)
    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
    expect(result.content.every((c: any) => !c.text?.startsWith("__nextPageToken:"))).toBe(true);
  });
});

describe("identifyActiveUsersHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns active users sorted by message count", async () => {
    const room = mockRoom();
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockCountByUser.mockReturnValue([
      { userId: "@alice:ex.com", count: 15 },
      { userId: "@bob:ex.com", count: 8 },
    ] as any);

    const result = await identifyActiveUsersHandler({ roomId: "!room:ex.com", limit: 10 }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain("@alice:ex.com");
    expect(result.content[0].text).toContain("15 messages");
    expect(result.content[1].text).toContain("@bob:ex.com");
    expect(result.content[1].text).toContain("8 messages");
  });

  it("returns 'no activity' when room has no messages", async () => {
    const room = mockRoom("Dead Room");
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockCountByUser.mockReturnValue([] as any);

    const result = await identifyActiveUsersHandler({ roomId: "!room:ex.com", limit: 10 }, reqContext);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("No message activity");
    expect(result.content[0].text).toContain("Dead Room");
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await identifyActiveUsersHandler({ roomId: "!missing:ex.com", limit: 10 }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("passes limit to countMessagesByUser", async () => {
    const room = mockRoom();
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);
    mockCountByUser.mockReturnValue([{ userId: "@a:ex.com", count: 1 }] as any);

    await identifyActiveUsersHandler({ roomId: "!room:ex.com", limit: 5 }, reqContext);
    expect(mockCountByUser).toHaveBeenCalledWith(expect.any(Array), 5);
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_FORBIDDEN"));

    const result = await identifyActiveUsersHandler({ roomId: "!room:ex.com", limit: 10 }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });
});
