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
const { listJoinedRoomsHandler, getRoomInfoHandler, getRoomMembersHandler } = await import("./rooms.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

describe("listJoinedRoomsHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists joined rooms", async () => {
    const client = {
      getRooms: () => [
        { name: "Room A", roomId: "!a:ex.com", getMyMembership: () => "join", getJoinedMemberCount: () => 5 },
        { name: "Room B", roomId: "!b:ex.com", getMyMembership: () => "join", getJoinedMemberCount: () => 2 },
        { name: "Left Room", roomId: "!c:ex.com", getMyMembership: () => "leave", getJoinedMemberCount: () => 0 },
      ],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await listJoinedRoomsHandler({}, reqContext);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain("Room A");
    expect(result.content[0].text).toContain("!a:ex.com");
    expect(result.content[0].text).toContain("5 members");
    expect(result.content[1].text).toContain("Room B");
  });

  it("returns empty list when no rooms joined", async () => {
    const client = { getRooms: () => [] };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await listJoinedRoomsHandler({}, reqContext);
    expect(result.content).toHaveLength(0);
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await listJoinedRoomsHandler({}, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to list joined rooms");
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("getRoomInfoHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns detailed room information", async () => {
    const room = {
      name: "Test Room",
      roomId: "!room:ex.com",
      getJoinedMemberCount: () => 10,
      hasEncryptionStateEvent: () => true,
      getCanonicalAlias: () => "#test:ex.com",
      currentState: {
        getStateEvents: (type: string, _key: string) => {
          if (type === "m.room.topic") return { getContent: () => ({ topic: "A test topic" }) };
          if (type === "m.room.create") return { getSender: () => "@admin:ex.com", getTs: () => 1700000000000 };
          return null;
        },
      },
    };
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomInfoHandler({ roomId: "!room:ex.com" }, reqContext);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Test Room");
    expect(text).toContain("#test:ex.com");
    expect(text).toContain("A test topic");
    expect(text).toContain("10");
    expect(text).toContain("Yes"); // encrypted
    expect(text).toContain("@admin:ex.com");
  });

  it("handles room with no topic or alias", async () => {
    const room = {
      name: null,
      roomId: "!bare:ex.com",
      getJoinedMemberCount: () => 1,
      hasEncryptionStateEvent: () => false,
      getCanonicalAlias: () => null,
      currentState: {
        getStateEvents: () => null,
      },
    };
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomInfoHandler({ roomId: "!bare:ex.com" }, reqContext);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Unnamed Room");
    expect(text).toContain("No topic set");
    expect(text).toContain("No alias");
    expect(text).toContain("No"); // not encrypted
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomInfoHandler({ roomId: "!missing:ex.com" }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("Network error"));

    const result = await getRoomInfoHandler({ roomId: "!room:ex.com" }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("getRoomMembersHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists room members with display names", async () => {
    const room = {
      name: "Team Room",
      getJoinedMembers: () => [
        { userId: "@alice:ex.com", name: "Alice" },
        { userId: "@bob:ex.com", name: "Bob" },
      ],
    };
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomMembersHandler({ roomId: "!room:ex.com" }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain("Alice");
    expect(result.content[0].text).toContain("@alice:ex.com");
    expect(result.content[1].text).toContain("Bob");
  });

  it("returns message when no members found", async () => {
    const room = { name: "Empty Room", getJoinedMembers: () => [] };
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomMembersHandler({ roomId: "!room:ex.com" }, reqContext);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("No members found");
  });

  it("uses userId as display name when name is missing", async () => {
    const room = {
      name: "Room",
      getJoinedMembers: () => [{ userId: "@noname:ex.com", name: null }],
    };
    const client = { getRoom: () => room };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomMembersHandler({ roomId: "!room:ex.com" }, reqContext);
    expect(result.content[0].text).toContain("@noname:ex.com");
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getRoomMembersHandler({ roomId: "!missing:ex.com" }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_FORBIDDEN"));

    const result = await getRoomMembersHandler({ roomId: "!room:ex.com" }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });
});
