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
const { getPendingInvitesHandler } = await import("./invites.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

describe("getPendingInvitesHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns pending invites with room info", async () => {
    const rooms = [
      {
        roomId: "!inv1:ex.com",
        name: "Secret Room",
        getMyMembership: () => "invite",
        currentState: {
          getMember: () => ({
            events: { member: { getSender: () => "@alice:ex.com" } },
          }),
        },
      },
      {
        roomId: "!inv2:ex.com",
        name: "Another Room",
        getMyMembership: () => "invite",
        currentState: {
          getMember: () => ({
            events: { member: { getSender: () => "@bob:ex.com" } },
          }),
        },
      },
      {
        roomId: "!joined:ex.com",
        name: "Already Joined",
        getMyMembership: () => "join",
      },
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getPendingInvitesHandler({}, reqContext);
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBe(2);
    const first = JSON.parse(result.content[0].text);
    expect(first.roomId).toBe("!inv1:ex.com");
    expect(first.roomName).toBe("Secret Room");
    expect(first.invitedBy).toBe("@alice:ex.com");
    const second = JSON.parse(result.content[1].text);
    expect(second.roomId).toBe("!inv2:ex.com");
    expect(second.invitedBy).toBe("@bob:ex.com");
  });

  it("returns 'no pending invites' when none exist", async () => {
    const rooms = [
      { roomId: "!room:ex.com", getMyMembership: () => "join" },
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getPendingInvitesHandler({}, reqContext);
    expect(result.content.length).toBe(1);
    expect(result.content[0].text).toContain("No pending invites");
  });

  it("uses roomId as name when name is missing", async () => {
    const rooms = [
      {
        roomId: "!noname:ex.com",
        name: "",
        getMyMembership: () => "invite",
        currentState: {
          getMember: () => ({
            events: { member: { getSender: () => "@a:ex.com" } },
          }),
        },
      },
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getPendingInvitesHandler({}, reqContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.roomName).toBe("!noname:ex.com");
  });

  it("returns 'unknown' inviter when member data is missing", async () => {
    const rooms = [
      {
        roomId: "!inv:ex.com",
        name: "Room",
        getMyMembership: () => "invite",
        currentState: { getMember: () => null },
      },
    ];
    const client = { getRooms: () => rooms };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getPendingInvitesHandler({}, reqContext);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.invitedBy).toBe("unknown");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await getPendingInvitesHandler({}, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to get pending invites");
    expect(result.content[0].text).toContain("get-server-health");
  });
});
