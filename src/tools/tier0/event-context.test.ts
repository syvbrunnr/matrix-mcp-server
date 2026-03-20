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
  processMessage: jest.fn<any>().mockResolvedValue({ type: "text", text: '{"sender":"@a:ex.com","body":"msg"}' }),
}));

// Dynamic imports after mocks
const { createConfiguredMatrixClient } = await import("../../utils/server-helpers.js");
const { processMessage } = await import("../../matrix/messageProcessor.js");
const { getEventContextHandler } = await import("./event-context.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const mockProcessMessage = processMessage as jest.MockedFunction<typeof processMessage>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function rawEvent(id: string, sender: string, body: string, ts: number) {
  return {
    event_id: id,
    type: "m.room.message",
    sender,
    content: { msgtype: "m.text", body },
    origin_server_ts: ts,
  };
}

describe("getEventContextHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns messages before and after the target event", async () => {
    const contextResponse = {
      event: rawEvent("$target", "@alice:ex.com", "target msg", 2000),
      events_before: [
        rawEvent("$before1", "@bob:ex.com", "before", 1000),
      ],
      events_after: [
        rawEvent("$after1", "@carol:ex.com", "after", 3000),
      ],
    };
    const mockAuthedRequest = jest.fn<any>().mockResolvedValue(contextResponse);
    const client = { http: { authedRequest: mockAuthedRequest } };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$before1","body":"before"}' } as any)
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$target","body":"target msg"}' } as any)
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$after1","body":"after"}' } as any);

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$target", limit: 10 },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBe(3);
    expect(mockProcessMessage).toHaveBeenCalledTimes(3);
  });

  it("marks the target event with isTargetEvent", async () => {
    const contextResponse = {
      event: rawEvent("$target", "@alice:ex.com", "target", 2000),
      events_before: [],
      events_after: [],
    };
    const client = { http: { authedRequest: jest.fn<any>().mockResolvedValue(contextResponse) } };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: '{"eventId":"$target","body":"target"}' } as any);

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$target", limit: 10 },
      reqContext
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.isTargetEvent).toBe(true);
  });

  it("does not mark non-target events with isTargetEvent", async () => {
    const contextResponse = {
      event: rawEvent("$target", "@alice:ex.com", "target", 2000),
      events_before: [rawEvent("$other", "@bob:ex.com", "other", 1000)],
      events_after: [],
    };
    const client = { http: { authedRequest: jest.fn<any>().mockResolvedValue(contextResponse) } };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$other","body":"other"}' } as any)
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$target","body":"target"}' } as any);

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$target", limit: 10 },
      reqContext
    );
    const firstParsed = JSON.parse(result.content[0].text);
    expect(firstParsed.isTargetEvent).toBeUndefined();
    const secondParsed = JSON.parse(result.content[1].text);
    expect(secondParsed.isTargetEvent).toBe(true);
  });

  it("filters out null messages", async () => {
    const contextResponse = {
      event: rawEvent("$target", "@alice:ex.com", "target", 2000),
      events_before: [rawEvent("$null", "@bob:ex.com", "null", 1000)],
      events_after: [],
    };
    const client = { http: { authedRequest: jest.fn<any>().mockResolvedValue(contextResponse) } };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$target","body":"target"}' } as any);

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$target", limit: 10 },
      reqContext
    );
    expect(result.content.length).toBe(1);
  });

  it("returns 'No messages found' when all messages are null", async () => {
    const contextResponse = {
      event: rawEvent("$target", "@alice:ex.com", "target", 2000),
      events_before: [],
      events_after: [],
    };
    const client = { http: { authedRequest: jest.fn<any>().mockResolvedValue(contextResponse) } };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue(null as any);

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$target", limit: 10 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No messages found");
    expect(result.content[0].text).toContain("$target");
  });

  it("passes limit to the context API call", async () => {
    const contextResponse = {
      event: rawEvent("$e1", "@a:ex.com", "msg", 1000),
      events_before: [],
      events_after: [],
    };
    const mockAuthedRequest = jest.fn<any>().mockResolvedValue(contextResponse);
    const client = { http: { authedRequest: mockAuthedRequest } };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: '{"eventId":"$e1"}' } as any);

    await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$e1", limit: 5 },
      reqContext
    );
    expect(mockAuthedRequest).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/context/"),
      { limit: "5" },
    );
  });

  it("encodes roomId and eventId in the URL path", async () => {
    const contextResponse = {
      event: rawEvent("$e1", "@a:ex.com", "msg", 1000),
      events_before: [],
      events_after: [],
    };
    const mockAuthedRequest = jest.fn<any>().mockResolvedValue(contextResponse);
    const client = { http: { authedRequest: mockAuthedRequest } };
    mockCreateClient.mockResolvedValue(client as any);
    mockProcessMessage.mockResolvedValue({ type: "text", text: '{"eventId":"$e1"}' } as any);

    await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$e1", limit: 10 },
      reqContext
    );
    const path = mockAuthedRequest.mock.calls[0][1] as string;
    expect(path).toContain(encodeURIComponent("!room:ex.com"));
    expect(path).toContain(encodeURIComponent("$e1"));
  });

  it("returns specific error for M_NOT_FOUND", async () => {
    const error = new Error("M_NOT_FOUND: Event not found");
    const client = { http: { authedRequest: jest.fn<any>().mockRejectedValue(error) } };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$missing", limit: 10 },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("$missing");
    expect(result.content[0].text).not.toContain("get-server-health");
  });

  it("returns error with diagnostic hint on general failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$e1", limit: 10 },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to get event context");
    expect(result.content[0].text).toContain("get-server-health");
  });

  it("orders events chronologically: before, target, after", async () => {
    const contextResponse = {
      event: rawEvent("$target", "@alice:ex.com", "target", 2000),
      events_before: [
        rawEvent("$b2", "@bob:ex.com", "b2", 900),
        rawEvent("$b1", "@bob:ex.com", "b1", 1000),
      ],
      events_after: [
        rawEvent("$a1", "@carol:ex.com", "a1", 3000),
      ],
    };
    const client = { http: { authedRequest: jest.fn<any>().mockResolvedValue(contextResponse) } };
    mockCreateClient.mockResolvedValue(client as any);

    // events_before is returned newest-first by Matrix, reversed in handler
    mockProcessMessage
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$b1","body":"b1"}' } as any)
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$b2","body":"b2"}' } as any)
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$target","body":"target"}' } as any)
      .mockResolvedValueOnce({ type: "text", text: '{"eventId":"$a1","body":"a1"}' } as any);

    const result = await getEventContextHandler(
      { roomId: "!room:ex.com", eventId: "$target", limit: 10 },
      reqContext
    );
    expect(result.content.length).toBe(4);
    // First two are before events (reversed), then target, then after
    const ids = result.content.map((c: any) => JSON.parse(c.text).eventId);
    expect(ids).toEqual(["$b1", "$b2", "$target", "$a1"]);
  });
});
