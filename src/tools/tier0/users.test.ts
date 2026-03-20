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
const { getUserProfileHandler, getMyProfileHandler, getAllUsersHandler, setDisplayNameHandler } = await import("./users.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

describe("getUserProfileHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns user profile with shared rooms", async () => {
    const user = {
      displayName: "Alice",
      avatarUrl: "mxc://ex.com/avatar",
      presence: "online",
      presenceStatusMsg: "Working",
      lastActiveAgo: 120000, // 2 minutes
    };
    const client = {
      getUser: () => user,
      getRooms: () => [
        { name: "Shared Room", getMember: () => ({ membership: "join" }) },
        { name: "Other Room", getMember: () => ({ membership: "leave" }) },
      ],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getUserProfileHandler({ targetUserId: "@alice:ex.com" }, reqContext);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Alice");
    expect(text).toContain("mxc://ex.com/avatar");
    expect(text).toContain("online");
    expect(text).toContain("Working");
    expect(text).toContain("2 minutes ago");
    expect(text).toContain("Shared Room");
  });

  it("returns error when user not found", async () => {
    const client = { getUser: () => null, getRooms: () => [] };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getUserProfileHandler({ targetUserId: "@unknown:ex.com" }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));

    const result = await getUserProfileHandler({ targetUserId: "@alice:ex.com" }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("getMyProfileHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns own profile with device info and room counts", async () => {
    const user = {
      displayName: "Bot",
      avatarUrl: null,
      presence: "online",
      presenceStatusMsg: null,
    };
    const client = {
      getUser: () => user,
      getDeviceId: () => "DEVICEABC",
      getDevices: jest.fn<any>().mockResolvedValue({
        devices: [
          { device_id: "DEVICEABC", display_name: "MCP Bot" },
          { device_id: "OTHER", display_name: "Phone" },
        ],
      }),
      getRooms: () => [
        { getMyMembership: () => "join", getJoinedMemberCount: () => 5 },
        { getMyMembership: () => "join", getJoinedMemberCount: () => 2 },
        { getMyMembership: () => "leave", getJoinedMemberCount: () => 0 },
      ],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getMyProfileHandler({}, reqContext);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Bot");
    expect(text).toContain("No avatar set");
    expect(text).toContain("MCP Bot");
    expect(text).toContain("DEVICEABC");
    expect(text).toContain("Total devices: 2");
    expect(text).toContain("Joined Rooms: 3");
    expect(text).toContain("Direct Messages: 1"); // room with 2 members
  });

  it("returns error when user object not found", async () => {
    const client = { getUser: () => null };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getMyProfileHandler({}, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Could not retrieve");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("Network error"));

    const result = await getMyProfileHandler({}, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("getAllUsersHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists all known users", async () => {
    const client = {
      getUsers: () => [
        { userId: "@alice:ex.com", displayName: "Alice" },
        { userId: "@bob:ex.com", displayName: null },
      ],
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getAllUsersHandler({}, reqContext);
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain("Alice");
    expect(result.content[1].text).toContain("@bob:ex.com");
  });

  it("returns message when no users found", async () => {
    const client = { getUsers: () => [] };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await getAllUsersHandler({}, reqContext);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("No users found");
  });

  it("returns error with diagnostic hint on failure", async () => {
    mockCreateClient.mockRejectedValue(new Error("M_FORBIDDEN"));

    const result = await getAllUsersHandler({}, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("setDisplayNameHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets display name successfully", async () => {
    const client = {
      getUser: () => ({ displayName: "Old Name" }),
      setDisplayName: jest.fn<any>().mockResolvedValue({}),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setDisplayNameHandler({ displayName: "New Name" }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Previous: Old Name");
    expect(result.content[0].text).toContain("New: New Name");
    expect(client.setDisplayName).toHaveBeenCalledWith("New Name");
  });

  it("returns error with diagnostic hint on failure", async () => {
    const client = {
      getUser: () => ({ displayName: "Old" }),
      setDisplayName: jest.fn<any>().mockRejectedValue(new Error("M_FORBIDDEN")),
    };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setDisplayNameHandler({ displayName: "New" }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to set display name");
    expect(result.content[0].text).toContain("get-server-health");
  });
});
