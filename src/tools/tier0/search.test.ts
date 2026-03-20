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
const { searchPublicRoomsHandler, searchMessagesHandler } = await import("./search.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

describe("searchPublicRoomsHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns formatted public rooms", async () => {
    const client = {
      publicRooms: jest.fn<any>().mockResolvedValue({
        chunk: [
          {
            room_id: "!room1:ex.com",
            name: "General",
            topic: "Main room",
            num_joined_members: 42,
            canonical_alias: "#general:ex.com",
            avatar_url: "mxc://ex.com/avatar",
          },
          {
            room_id: "!room2:ex.com",
            name: "Dev",
            topic: "Development",
            num_joined_members: 10,
          },
        ],
      }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchPublicRoomsHandler(
      { searchTerm: "general", limit: 20 },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBe(3); // header + 2 rooms
    expect(result.content[0].text).toContain("Found 2 public rooms");
    expect(result.content[0].text).toContain('"general"');
    expect(result.content[1].text).toContain("General");
    expect(result.content[1].text).toContain("#general:ex.com");
    expect(result.content[1].text).toContain("Has avatar");
    expect(result.content[2].text).toContain("Dev");
    expect(result.content[2].text).toContain("No avatar");
  });

  it("returns 'no rooms found' with search term", async () => {
    const client = {
      publicRooms: jest.fn<any>().mockResolvedValue({ chunk: [] }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchPublicRoomsHandler(
      { searchTerm: "nonexistent", limit: 20 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No public rooms found");
    expect(result.content[0].text).toContain("nonexistent");
  });

  it("returns 'no rooms found' without search term", async () => {
    const client = {
      publicRooms: jest.fn<any>().mockResolvedValue({ chunk: [] }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchPublicRoomsHandler(
      { limit: 20 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toBe("No public rooms found");
  });

  it("passes search term as filter to publicRooms", async () => {
    const mockPublicRooms = jest.fn<any>().mockResolvedValue({ chunk: [] });
    const client = { publicRooms: mockPublicRooms };
    mockCreateClient.mockResolvedValue(client as any);

    await searchPublicRoomsHandler(
      { searchTerm: "dev", limit: 10 },
      reqContext
    );
    expect(mockPublicRooms).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
        filter: { generic_search_term: "dev" },
      })
    );
  });

  it("passes server option to publicRooms", async () => {
    const mockPublicRooms = jest.fn<any>().mockResolvedValue({ chunk: [] });
    const client = { publicRooms: mockPublicRooms };
    mockCreateClient.mockResolvedValue(client as any);

    await searchPublicRoomsHandler(
      { server: "matrix.org", limit: 20 },
      reqContext
    );
    expect(mockPublicRooms).toHaveBeenCalledWith(
      expect.objectContaining({ server: "matrix.org" })
    );
  });

  it("handles rooms with missing fields gracefully", async () => {
    const client = {
      publicRooms: jest.fn<any>().mockResolvedValue({
        chunk: [{ room_id: "!bare:ex.com" }],
      }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchPublicRoomsHandler({ limit: 20 }, reqContext);
    expect(result.content[1].text).toContain("Unnamed Room");
    expect(result.content[1].text).toContain("No topic");
    expect(result.content[1].text).toContain("Members: 0");
    expect(result.content[1].text).toContain("!bare:ex.com");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await searchPublicRoomsHandler({ limit: 20 }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to search public rooms");
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("searchMessagesHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns server-side search results", async () => {
    const mockEvent = {
      getId: () => "$ev1",
      getRoomId: () => "!room:ex.com",
      getSender: () => "@alice:ex.com",
      getTs: () => 1700000000000,
      getContent: () => ({ body: "hello world" }),
      getClearContent: () => null,
    };
    const client = {
      searchRoomEvents: jest.fn<any>().mockResolvedValue({
        results: [{ context: { getEvent: () => mockEvent } }],
        count: 1,
      }),
      getRoom: () => ({ name: "General" }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "hello", limit: 20 },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBe(2); // header + 1 result
    expect(result.content[0].text).toContain('Found 1 message matching "hello"');
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed.eventId).toBe("$ev1");
    expect(parsed.sender).toBe("@alice:ex.com");
    expect(parsed.body).toBe("hello world");
    expect(parsed.roomName).toBe("General");
  });

  it("passes roomId and sender filters to server-side search", async () => {
    const mockSearchRoomEvents = jest.fn<any>().mockResolvedValue({ results: [], count: 0 });
    const client = {
      searchRoomEvents: mockSearchRoomEvents,
      getRoom: () => ({ name: "Test" }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    await searchMessagesHandler(
      { query: "test", roomId: "!room:ex.com", sender: "@alice:ex.com", limit: 20 },
      reqContext
    );
    expect(mockSearchRoomEvents).toHaveBeenCalledWith({
      term: "test",
      filter: { rooms: ["!room:ex.com"], senders: ["@alice:ex.com"] },
    });
  });

  it("returns 'no messages' on server-side empty results", async () => {
    const client = {
      searchRoomEvents: jest.fn<any>().mockResolvedValue({ results: [], count: 0 }),
      getRoom: () => ({ name: "General" }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "nonexistent", roomId: "!room:ex.com", limit: 20 },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain('No messages matching "nonexistent"');
    expect(result.content[0].text).toContain("General");
  });

  it("returns 'no messages' without roomId on empty results", async () => {
    const client = {
      searchRoomEvents: jest.fn<any>().mockResolvedValue({ results: [], count: 0 }),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "missing", limit: 20 },
      reqContext
    );
    expect(result.content[0].text).toContain("any joined room");
  });

  it("respects limit on server-side results", async () => {
    const makeEvent = (id: string) => ({
      getId: () => id,
      getRoomId: () => "!room:ex.com",
      getSender: () => "@a:ex.com",
      getTs: () => 1000,
      getContent: () => ({ body: "msg" }),
      getClearContent: () => null,
    });
    const client = {
      searchRoomEvents: jest.fn<any>().mockResolvedValue({
        results: [
          { context: { getEvent: () => makeEvent("$1") } },
          { context: { getEvent: () => makeEvent("$2") } },
          { context: { getEvent: () => makeEvent("$3") } },
        ],
        count: 10,
      }),
      getRoom: () => ({ name: "R" }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "msg", limit: 2 },
      reqContext
    );
    // header + 2 limited results
    expect(result.content.length).toBe(3);
    expect(result.content[0].text).toContain("showing 2");
  });

  it("falls back to client-side search on 501", async () => {
    const searchErr: any = new Error("Not Implemented");
    searchErr.httpStatus = 501;

    const timelineEvent = {
      getType: () => "m.room.message",
      getContent: () => ({ body: "found locally" }),
      getClearContent: () => null,
      getSender: () => "@bob:ex.com",
      getId: () => "$local1",
      getTs: () => 1700000000000,
      isRedacted: () => false,
    };
    const room = {
      roomId: "!room:ex.com",
      name: "General",
      getMyMembership: () => "join",
      getLiveTimeline: () => ({ getEvents: () => [timelineEvent] }),
    };
    const client = {
      searchRoomEvents: jest.fn<any>().mockRejectedValue(searchErr),
      getRoom: () => room,
      getRooms: () => [room],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "found", limit: 20 },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("synced history");
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed.body).toBe("found locally");
    expect(parsed.sender).toBe("@bob:ex.com");
  });

  it("falls back to client-side search on 404", async () => {
    const searchErr: any = new Error("Not Found");
    searchErr.httpStatus = 404;

    const room = {
      roomId: "!room:ex.com",
      name: "R",
      getMyMembership: () => "join",
      getLiveTimeline: () => ({ getEvents: () => [] }),
    };
    const client = {
      searchRoomEvents: jest.fn<any>().mockRejectedValue(searchErr),
      getRoom: () => room,
      getRooms: () => [room],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "missing", limit: 20 },
      reqContext
    );
    expect(result.content[0].text).toContain("No messages matching");
  });

  it("client-side search filters out m.replace events", async () => {
    const searchErr: any = new Error("Not Implemented");
    searchErr.httpStatus = 501;

    const originalEvent = {
      getType: () => "m.room.message",
      getContent: () => ({ body: "original text" }),
      getClearContent: () => null,
      getSender: () => "@a:ex.com",
      getId: () => "$orig",
      getTs: () => 1000,
      isRedacted: () => false,
    };
    const editEvent = {
      getType: () => "m.room.message",
      getContent: () => ({
        body: "edited text with original keyword",
        "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
      }),
      getClearContent: () => null,
      getSender: () => "@a:ex.com",
      getId: () => "$edit",
      getTs: () => 2000,
      isRedacted: () => false,
    };
    const room = {
      roomId: "!r:ex.com",
      name: "R",
      getMyMembership: () => "join",
      getLiveTimeline: () => ({ getEvents: () => [originalEvent, editEvent] }),
    };
    const client = {
      searchRoomEvents: jest.fn<any>().mockRejectedValue(searchErr),
      getRoom: () => room,
      getRooms: () => [room],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "original", limit: 20 },
      reqContext
    );
    // Only the original event should match, not the edit
    expect(result.content.length).toBe(2); // header + 1 result
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed.eventId).toBe("$orig");
  });

  it("client-side search filters out redacted events", async () => {
    const searchErr: any = new Error("Not Implemented");
    searchErr.httpStatus = 501;

    const normalEvent = {
      getType: () => "m.room.message",
      getContent: () => ({ body: "visible message" }),
      getClearContent: () => null,
      getSender: () => "@a:ex.com",
      getId: () => "$vis",
      getTs: () => 1000,
      isRedacted: () => false,
    };
    const redactedEvent = {
      getType: () => "m.room.message",
      getContent: () => ({ body: "visible but redacted" }),
      getClearContent: () => null,
      getSender: () => "@b:ex.com",
      getId: () => "$red",
      getTs: () => 2000,
      isRedacted: () => true,
    };
    const room = {
      roomId: "!r:ex.com",
      name: "R",
      getMyMembership: () => "join",
      getLiveTimeline: () => ({ getEvents: () => [normalEvent, redactedEvent] }),
    };
    const client = {
      searchRoomEvents: jest.fn<any>().mockRejectedValue(searchErr),
      getRoom: () => room,
      getRooms: () => [room],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "visible", limit: 20 },
      reqContext
    );
    expect(result.content.length).toBe(2); // header + 1 result
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed.eventId).toBe("$vis");
  });

  it("client-side search filters by sender", async () => {
    const searchErr: any = new Error("Not Implemented");
    searchErr.httpStatus = 501;

    const ev1 = {
      getType: () => "m.room.message",
      getContent: () => ({ body: "hello from alice" }),
      getClearContent: () => null,
      getSender: () => "@alice:ex.com",
      getId: () => "$a1",
      getTs: () => 1000,
      isRedacted: () => false,
    };
    const ev2 = {
      getType: () => "m.room.message",
      getContent: () => ({ body: "hello from bob" }),
      getClearContent: () => null,
      getSender: () => "@bob:ex.com",
      getId: () => "$b1",
      getTs: () => 2000,
      isRedacted: () => false,
    };
    const room = {
      roomId: "!r:ex.com",
      name: "R",
      getMyMembership: () => "join",
      getLiveTimeline: () => ({ getEvents: () => [ev1, ev2] }),
    };
    const client = {
      searchRoomEvents: jest.fn<any>().mockRejectedValue(searchErr),
      getRoom: () => room,
      getRooms: () => [room],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "hello", sender: "@alice:ex.com", limit: 20 },
      reqContext
    );
    expect(result.content.length).toBe(2);
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed.sender).toBe("@alice:ex.com");
  });

  it("client-side search scopes to specific room when roomId provided", async () => {
    const searchErr: any = new Error("Not Implemented");
    searchErr.httpStatus = 501;

    const ev = {
      getType: () => "m.room.message",
      getContent: () => ({ body: "target msg" }),
      getClearContent: () => null,
      getSender: () => "@a:ex.com",
      getId: () => "$t1",
      getTs: () => 1000,
      isRedacted: () => false,
    };
    const targetRoom = {
      roomId: "!target:ex.com",
      name: "Target",
      getMyMembership: () => "join",
      getLiveTimeline: () => ({ getEvents: () => [ev] }),
    };
    const otherRoom = {
      roomId: "!other:ex.com",
      name: "Other",
      getMyMembership: () => "join",
      getLiveTimeline: () => ({
        getEvents: () => [{
          getType: () => "m.room.message",
          getContent: () => ({ body: "target in other room" }),
          getClearContent: () => null,
          getSender: () => "@b:ex.com",
          getId: () => "$o1",
          getTs: () => 2000,
          isRedacted: () => false,
        }],
      }),
    };
    const client = {
      searchRoomEvents: jest.fn<any>().mockRejectedValue(searchErr),
      getRoom: (id: string) => id === "!target:ex.com" ? targetRoom : otherRoom,
      getRooms: () => [targetRoom, otherRoom],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "target", roomId: "!target:ex.com", limit: 20 },
      reqContext
    );
    expect(result.content.length).toBe(2);
    const parsed = JSON.parse(result.content[1].text);
    expect(parsed.roomId).toBe("!target:ex.com");
  });

  it("re-throws non-fallback search errors", async () => {
    const searchErr: any = new Error("M_FORBIDDEN");
    searchErr.httpStatus = 403;

    const client = {
      searchRoomEvents: jest.fn<any>().mockRejectedValue(searchErr),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await searchMessagesHandler(
      { query: "test", limit: 20 },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to search messages");
    expect(result.content[0].text).toContain("get-server-health");
  });

  it("returns error with diagnostic hint on client creation failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await searchMessagesHandler(
      { query: "test", limit: 20 },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to search messages");
    expect(result.content[0].text).toContain("get-server-health");
  });
});
