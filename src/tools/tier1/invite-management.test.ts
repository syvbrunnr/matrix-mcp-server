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
const { inviteUserHandler } = await import("./invite-management.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function mockRoom(opts: { name?: string; powerLevel?: number; inviteLevel?: number; memberOverride?: any } = {}) {
  return {
    name: opts.name ?? "Test Room",
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

describe("inviteUserHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("invites a user successfully", async () => {
    const room = mockRoom({
      name: "Invite Room",
      memberOverride: (userId: string) => {
        if (userId === "@target:ex.com") return null; // target not in room
        return { powerLevel: 100, membership: "join" };
      },
    });
    const client = {
      getRoom: () => room,
      invite: jest.fn<any>().mockResolvedValue({}),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await inviteUserHandler(
      { roomId: "!room:ex.com", targetUserId: "@target:ex.com" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Successfully invited");
    expect(result.content[0].text).toContain("@target:ex.com");
    expect(result.content[0].text).toContain("Invite Room");
    expect(client.invite).toHaveBeenCalledWith("!room:ex.com", "@target:ex.com");
  });

  it("returns early when target is already a member", async () => {
    const room = mockRoom({ name: "Full Room" });
    const client = { getRoom: () => room, invite: jest.fn() };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await inviteUserHandler(
      { roomId: "!room:ex.com", targetUserId: "@existing:ex.com" },
      reqContext
    );
    expect(result.content[0].text).toContain("already a member");
    expect(client.invite).not.toHaveBeenCalled();
  });

  it("returns early when target is already invited", async () => {
    const room = mockRoom({
      memberOverride: (userId: string) => {
        if (userId === "@pending:ex.com") return { powerLevel: 0, membership: "invite" };
        return { powerLevel: 100, membership: "join" };
      },
    });
    const client = { getRoom: () => room, invite: jest.fn() };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await inviteUserHandler(
      { roomId: "!room:ex.com", targetUserId: "@pending:ex.com" },
      reqContext
    );
    expect(result.content[0].text).toContain("already been invited");
  });

  it("returns error when target is banned", async () => {
    const room = mockRoom({
      memberOverride: (userId: string) => {
        if (userId === "@banned:ex.com") return { powerLevel: 0, membership: "ban" };
        return { powerLevel: 100, membership: "join" };
      },
    });
    const client = { getRoom: () => room, invite: jest.fn() };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await inviteUserHandler(
      { roomId: "!room:ex.com", targetUserId: "@banned:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("banned");
  });

  it("returns error when insufficient invite permissions", async () => {
    const room = mockRoom({
      powerLevel: 0,
      inviteLevel: 50,
      memberOverride: (userId: string) => {
        if (userId === "@target:ex.com") return null;
        return { powerLevel: 0, membership: "join" };
      },
    });
    const client = { getRoom: () => room, invite: jest.fn() };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await inviteUserHandler(
      { roomId: "!room:ex.com", targetUserId: "@target:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission");
    expect(result.content[0].text).toContain("50");
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null, invite: jest.fn() };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await inviteUserHandler(
      { roomId: "!missing:ex.com", targetUserId: "@target:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on SDK failure", async () => {
    const room = mockRoom({
      memberOverride: (userId: string) => {
        if (userId === "@target:ex.com") return null;
        return { powerLevel: 100, membership: "join" };
      },
    });
    const client = {
      getRoom: () => room,
      invite: jest.fn<any>().mockRejectedValue(new Error("M_FORBIDDEN")),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await inviteUserHandler(
      { roomId: "!room:ex.com", targetUserId: "@target:ex.com" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot invite");
    expect(result.content[0].text).toContain("get-server-health");
  });
});
