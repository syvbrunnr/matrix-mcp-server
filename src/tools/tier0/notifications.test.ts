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
const { getNotificationCountsHandler, getDirectMessagesHandler } = await import("./notifications.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function mockRoom(opts: {
  roomId: string; name?: string; unread?: number; mentions?: number;
  lastTs?: number; memberCount?: number; membership?: string;
  members?: { userId: string; name?: string }[];
  lastBody?: string;
}) {
  return {
    roomId: opts.roomId,
    name: opts.name || "Unnamed Room",
    getUnreadNotificationCount: (type?: any) =>
      type ? (opts.mentions ?? 0) : (opts.unread ?? 0),
    getLastLiveEvent: () =>
      opts.lastTs
        ? { getTs: () => opts.lastTs, getContent: () => ({ body: opts.lastBody || "last msg" }) }
        : null,
    getJoinedMemberCount: () => opts.memberCount ?? 5,
    getMyMembership: () => opts.membership ?? "join",
    getJoinedMembers: () =>
      opts.members?.map((m) => ({ userId: m.userId, name: m.name || m.userId })) ?? [],
  };
}

describe("getNotificationCountsHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns summary with rooms that have notifications", async () => {
    const rooms = [
      mockRoom({ roomId: "!r1:ex.com", name: "General", unread: 5, mentions: 2, lastTs: 1700000000000 }),
      mockRoom({ roomId: "!r2:ex.com", name: "Quiet", unread: 0, mentions: 0 }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getNotificationCountsHandler({}, reqContext);
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBe(2); // summary + 1 room with notifications
    expect(result.content[0].text).toContain("Total unread messages: 5");
    expect(result.content[0].text).toContain("Total mentions/highlights: 2");
    expect(result.content[0].text).toContain("Rooms with notifications: 1");
    expect(result.content[1].text).toContain("General");
    expect(result.content[1].text).toContain("Unread: 5");
    expect(result.content[1].text).toContain("Mentions: 2");
  });

  it("returns 'no notifications' when all rooms are quiet", async () => {
    const rooms = [
      mockRoom({ roomId: "!r1:ex.com", unread: 0, mentions: 0 }),
      mockRoom({ roomId: "!r2:ex.com", unread: 0, mentions: 0 }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getNotificationCountsHandler({}, reqContext);
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No unread notifications");
  });

  it("filters to specific room when roomFilter provided", async () => {
    const rooms = [
      mockRoom({ roomId: "!r1:ex.com", name: "Target", unread: 3, mentions: 1, lastTs: 1000 }),
      mockRoom({ roomId: "!r2:ex.com", name: "Other", unread: 10, mentions: 5, lastTs: 2000 }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getNotificationCountsHandler(
      { roomFilter: "!r1:ex.com" },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("Target");
    expect(result.content[0].text).toContain("Unread: 3");
    // Should NOT contain Other room
    expect(result.content[0].text).not.toContain("Other");
  });

  it("shows room even with zero notifications when roomFilter used", async () => {
    const rooms = [
      mockRoom({ roomId: "!r1:ex.com", name: "Quiet Room", unread: 0, mentions: 0, lastTs: 1000 }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getNotificationCountsHandler(
      { roomFilter: "!r1:ex.com" },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("Quiet Room");
    expect(result.content[0].text).toContain("Unread: 0");
  });

  it("returns error when roomFilter matches no room", async () => {
    const client = { getRooms: () => [] };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getNotificationCountsHandler(
      { roomFilter: "!missing:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("!missing:ex.com");
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await getNotificationCountsHandler({}, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to get notification counts");
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("getDirectMessagesHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns DM conversations sorted by recent activity", async () => {
    const rooms = [
      mockRoom({
        roomId: "!dm1:ex.com", memberCount: 2, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@alice:ex.com", name: "Alice" }],
        lastTs: 1000, lastBody: "hi there",
        unread: 2, mentions: 1,
      }),
      mockRoom({
        roomId: "!dm2:ex.com", memberCount: 2, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@bob:ex.com", name: "Bob" }],
        lastTs: 2000, lastBody: "latest msg",
        unread: 0, mentions: 0,
      }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getDirectMessagesHandler(
      { includeEmpty: false },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBe(3); // header + 2 DMs
    expect(result.content[0].text).toContain("Found 2 direct message conversations");
    // Bob should be first (more recent)
    expect(result.content[1].text).toContain("Bob");
    expect(result.content[2].text).toContain("Alice");
  });

  it("excludes group rooms (memberCount != 2)", async () => {
    const rooms = [
      mockRoom({
        roomId: "!group:ex.com", memberCount: 5, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@alice:ex.com" }],
        lastTs: 1000,
      }),
      mockRoom({
        roomId: "!dm:ex.com", memberCount: 2, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@bob:ex.com", name: "Bob" }],
        lastTs: 2000,
      }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getDirectMessagesHandler(
      { includeEmpty: false },
      reqContext
    );
    expect(result.content.length).toBe(2); // header + 1 DM
    expect(result.content[1].text).toContain("Bob");
  });

  it("excludes rooms where user is not joined", async () => {
    const rooms = [
      mockRoom({
        roomId: "!left:ex.com", memberCount: 2, membership: "leave",
        members: [{ userId: "@bot:example.com" }, { userId: "@alice:ex.com" }],
        lastTs: 1000,
      }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getDirectMessagesHandler(
      { includeEmpty: false },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No direct message conversations found");
  });

  it("excludes DMs without last event when includeEmpty is false", async () => {
    const rooms = [
      mockRoom({
        roomId: "!empty:ex.com", memberCount: 2, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@alice:ex.com" }],
        // No lastTs means no last event
      }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getDirectMessagesHandler(
      { includeEmpty: false },
      reqContext
    );
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No direct message conversations with recent activity");
  });

  it("includes DMs without last event when includeEmpty is true", async () => {
    const rooms = [
      mockRoom({
        roomId: "!empty:ex.com", memberCount: 2, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@alice:ex.com", name: "Alice" }],
        lastTs: 0, // has getLastLiveEvent returning null
      }),
    ];
    // Override getLastLiveEvent to return null
    (rooms[0] as any).getLastLiveEvent = () => null;
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getDirectMessagesHandler(
      { includeEmpty: true },
      reqContext
    );
    expect(result.content.length).toBe(2); // header + 1 DM
    expect(result.content[1].text).toContain("Alice");
  });

  it("truncates long message previews to 100 chars", async () => {
    const longBody = "A".repeat(150);
    const rooms = [
      mockRoom({
        roomId: "!dm:ex.com", memberCount: 2, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@alice:ex.com" }],
        lastTs: 1000, lastBody: longBody,
      }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getDirectMessagesHandler(
      { includeEmpty: false },
      reqContext
    );
    expect(result.content[1].text).toContain("...");
    expect(result.content[1].text).not.toContain(longBody);
  });

  it("returns singular 'conversation' for single DM", async () => {
    const rooms = [
      mockRoom({
        roomId: "!dm:ex.com", memberCount: 2, membership: "join",
        members: [{ userId: "@bot:example.com" }, { userId: "@alice:ex.com" }],
        lastTs: 1000,
      }),
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getDirectMessagesHandler(
      { includeEmpty: false },
      reqContext
    );
    expect(result.content[0].text).toContain("1 direct message conversation:");
    expect(result.content[0].text).not.toContain("conversations:");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await getDirectMessagesHandler(
      { includeEmpty: false },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to get direct messages");
    expect(result.content[0].text).toContain("get-server-health");
  });
});
