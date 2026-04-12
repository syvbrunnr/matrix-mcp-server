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

jest.unstable_mockModule("../../matrix/notificationSubscriptions.js", () => ({
  getSubscription: jest.fn<any>().mockReturnValue(null),
  setSubscription: jest.fn(),
}));

// Dynamic imports after mocks
const { createConfiguredMatrixClient } = await import("../../utils/server-helpers.js");
const { createRoomHandler, joinRoomHandler, leaveRoomHandler } = await import("./room-management.js");
const { getSubscription, setSubscription } = await import("../../matrix/notificationSubscriptions.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const mockGetSubscription = getSubscription as jest.MockedFunction<typeof getSubscription>;
const mockSetSubscription = setSubscription as jest.MockedFunction<typeof setSubscription>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function mockRoom(opts: { name?: string; membership?: string; memberCount?: number; powerLevel?: number; inviteLevel?: number; memberOverride?: any } = {}) {
  return {
    name: opts.name ?? "Test Room",
    getMyMembership: () => opts.membership ?? "join",
    getJoinedMemberCount: () => opts.memberCount ?? 3,
    getMember: opts.memberOverride ?? ((_userId: string) => ({ powerLevel: opts.powerLevel ?? 100, membership: "join" })),
    currentState: {
      getStateEvents: (type: string, _key: string) => {
        if (type === "m.room.power_levels") {
          return { getContent: () => ({ invite: opts.inviteLevel ?? 0 }) };
        }
        return null;
      },
    },
  };
}

describe("createRoomHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates a public room successfully", async () => {
    const client = {
      createRoom: jest.fn<any>().mockResolvedValue({ room_id: "!new:ex.com" }),
      getRoom: () => mockRoom({ name: "My Room", memberCount: 1 }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await createRoomHandler(
      { roomName: "My Room", isPrivate: false },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Successfully created room");
    expect(result.content[0].text).toContain("!new:ex.com");
    expect(result.content[0].text).toContain("Public");
    expect(client.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Room", visibility: "public", preset: "public_chat" })
    );
  });

  it("creates a private room with topic, alias, and invites", async () => {
    const client = {
      createRoom: jest.fn<any>().mockResolvedValue({ room_id: "!priv:ex.com" }),
      getRoom: () => mockRoom({ name: "Secret Room" }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await createRoomHandler(
      {
        roomName: "Secret Room",
        isPrivate: true,
        topic: "Top secret",
        inviteUsers: ["@alice:ex.com"],
        roomAlias: "secret",
      },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Private");
    expect(result.content[0].text).toContain("Top secret");
    expect(result.content[0].text).toContain("@alice:ex.com");
    expect(result.content[0].text).toContain("#secret:example.com");
    expect(client.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "private_chat",
        topic: "Top secret",
        invite: ["@alice:ex.com"],
        room_alias_name: "secret",
        initial_state: expect.arrayContaining([
          expect.objectContaining({ type: "m.room.encryption" }),
        ]),
      })
    );
  });

  it("returns specific error for alias in use", async () => {
    const client = {
      createRoom: jest.fn<any>().mockRejectedValue(new Error("M_ROOM_IN_USE")),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await createRoomHandler(
      { roomName: "Dupe", isPrivate: false, roomAlias: "taken" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already in use");
    expect(result.content[0].text).toContain("get-server-health");
  });

  it("returns specific error for M_FORBIDDEN", async () => {
    const client = {
      createRoom: jest.fn<any>().mockRejectedValue(new Error("M_FORBIDDEN")),
      getRoom: () => null,
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await createRoomHandler(
      { roomName: "Nope", isPrivate: false },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission");
  });
});

describe("joinRoomHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("joins a room successfully", async () => {
    const client = {
      getRoom: jest.fn<any>()
        .mockReturnValueOnce(null) // first call: not already joined
        .mockReturnValueOnce(mockRoom({ name: "Welcome Room", memberCount: 5 })), // after join
      joinRoom: jest.fn<any>().mockResolvedValue({ roomId: "!joined:ex.com" }),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await joinRoomHandler(
      { roomIdOrAlias: "#welcome:ex.com" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Successfully joined");
    expect(result.content[0].text).toContain("Welcome Room");
    expect(result.content[0].text).toContain("Joined via alias: #welcome:ex.com");
  });

  it("returns early when already a member", async () => {
    const room = mockRoom({ name: "Already Here" });
    const client = {
      getRoom: () => room,
      joinRoom: jest.fn(),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await joinRoomHandler(
      { roomIdOrAlias: "!room:ex.com" },
      reqContext
    );
    expect(result.content[0].text).toContain("already a member");
    expect(client.joinRoom).not.toHaveBeenCalled();
  });

  it("auto-adds to notification subscription after join", async () => {
    const client = {
      getRoom: jest.fn<any>()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(mockRoom()),
      joinRoom: jest.fn<any>().mockResolvedValue({ roomId: "!joined:ex.com" }),
    };
    mockCreateClient.mockResolvedValue(client as any);
    mockGetSubscription.mockReturnValue({ all: false, rooms: ["!other:ex.com"], dms: false } as any);

    await joinRoomHandler({ roomIdOrAlias: "!joined:ex.com" }, reqContext);
    expect(mockSetSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ rooms: expect.arrayContaining(["!joined:ex.com", "!other:ex.com"]) })
    );
  });

  it("returns error for M_NOT_FOUND", async () => {
    const client = {
      getRoom: () => null,
      joinRoom: jest.fn<any>().mockRejectedValue(new Error("M_NOT_FOUND")),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await joinRoomHandler(
      { roomIdOrAlias: "!missing:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("leaveRoomHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("leaves a room successfully", async () => {
    const client = {
      getRoom: () => mockRoom({ name: "Goodbye Room" }),
      leave: jest.fn<any>().mockResolvedValue({}),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await leaveRoomHandler(
      { roomId: "!room:ex.com" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Successfully left");
    expect(result.content[0].text).toContain("Goodbye Room");
    expect(client.leave).toHaveBeenCalledWith("!room:ex.com");
  });

  it("leaves with reason using membershipChange", async () => {
    const client = {
      getRoom: () => mockRoom({ name: "Leaving Room" }),
      leave: jest.fn(),
      membershipChange: jest.fn<any>().mockResolvedValue({}),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await leaveRoomHandler(
      { roomId: "!room:ex.com", reason: "Moving on" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Reason: Moving on");
    expect(client.membershipChange).toHaveBeenCalledWith("!room:ex.com", undefined, "leave", "Moving on");
    expect(client.leave).not.toHaveBeenCalled();
  });

  it("returns error when room not found", async () => {
    const client = {
      getRoom: () => null,
      leave: jest.fn(),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await leaveRoomHandler(
      { roomId: "!missing:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns early when not joined", async () => {
    const client = {
      getRoom: () => mockRoom({ name: "Not Joined", membership: "invite" }),
      leave: jest.fn(),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await leaveRoomHandler(
      { roomId: "!room:ex.com" },
      reqContext
    );
    expect(result.content[0].text).toContain("not currently joined");
    expect(result.content[0].text).toContain("invite");
  });

  it("returns error with diagnostic hint on SDK failure", async () => {
    const client = {
      getRoom: () => mockRoom(),
      leave: jest.fn<any>().mockRejectedValue(new Error("M_FORBIDDEN")),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await leaveRoomHandler(
      { roomId: "!room:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot leave room");
    expect(result.content[0].text).toContain("get-server-health");
  });
});

