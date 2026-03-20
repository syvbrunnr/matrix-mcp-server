import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Set up mocks before importing the module under test
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
}));

// Dynamic imports after mocks
const { createConfiguredMatrixClient } = await import("../../utils/server-helpers.js");
const { setJoinRulesHandler, setHistoryVisibilityHandler } = await import("./room-admin.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;

function mockRoom(opts: {
  name?: string;
  joinRule?: string;
  historyVisibility?: string;
  userPowerLevel?: number;
  requiredLevel?: number;
  eventLevels?: Record<string, number>;
}) {
  const stateEvents: Record<string, any> = {
    "m.room.power_levels": {
      getContent: () => ({
        state_default: opts.requiredLevel ?? 50,
        events: opts.eventLevels ?? {},
      }),
    },
    "m.room.join_rules": {
      getContent: () => ({ join_rule: opts.joinRule ?? "invite" }),
    },
    "m.room.history_visibility": {
      getContent: () => ({ history_visibility: opts.historyVisibility ?? "shared" }),
    },
  };

  return {
    name: opts.name ?? "Test Room",
    currentState: {
      getStateEvents: (type: string, _key: string) => stateEvents[type] || null,
    },
    getMember: (_userId: string) => ({
      powerLevel: opts.userPowerLevel ?? 100,
    }),
  };
}

function mockClient(room: any) {
  return {
    getRoom: (_roomId: string) => room,
    sendStateEvent: jest.fn<any>().mockResolvedValue({}),
  };
}

const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

describe("setJoinRulesHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets join rule to public", async () => {
    const room = mockRoom({ joinRule: "invite" });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setJoinRulesHandler({ roomId: "!room:ex.com", joinRule: "public" as any }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(client.sendStateEvent).toHaveBeenCalledWith("!room:ex.com", "m.room.join_rules", { join_rule: "public" });
    expect(result.content[0].text).toContain("Previous: invite");
    expect(result.content[0].text).toContain("New: public");
  });

  it("sets join rule to knock", async () => {
    const room = mockRoom({ joinRule: "public" });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setJoinRulesHandler({ roomId: "!room:ex.com", joinRule: "knock" as any }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(client.sendStateEvent).toHaveBeenCalledWith("!room:ex.com", "m.room.join_rules", { join_rule: "knock" });
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null, sendStateEvent: jest.fn() };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setJoinRulesHandler({ roomId: "!missing:ex.com", joinRule: "public" as any }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error when insufficient permissions", async () => {
    const room = mockRoom({ userPowerLevel: 0, requiredLevel: 50 });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setJoinRulesHandler({ roomId: "!room:ex.com", joinRule: "public" as any }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission");
  });

  it("respects event-specific power level override", async () => {
    const room = mockRoom({
      userPowerLevel: 60,
      requiredLevel: 50,
      eventLevels: { "m.room.join_rules": 100 },
    });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setJoinRulesHandler({ roomId: "!room:ex.com", joinRule: "invite" as any }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("100");
  });

  it("handles SDK errors gracefully", async () => {
    const room = mockRoom({});
    const client = mockClient(room);
    client.sendStateEvent.mockRejectedValue(new Error("M_FORBIDDEN: not allowed") as never);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setJoinRulesHandler({ roomId: "!room:ex.com", joinRule: "public" as any }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission");
  });
});

describe("setHistoryVisibilityHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets history visibility to world_readable", async () => {
    const room = mockRoom({ historyVisibility: "shared" });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setHistoryVisibilityHandler({ roomId: "!room:ex.com", historyVisibility: "world_readable" as any }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(client.sendStateEvent).toHaveBeenCalledWith("!room:ex.com", "m.room.history_visibility", { history_visibility: "world_readable" });
    expect(result.content[0].text).toContain("Previous: shared");
    expect(result.content[0].text).toContain("New: world_readable");
  });

  it("sets history visibility to invited", async () => {
    const room = mockRoom({ historyVisibility: "shared" });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setHistoryVisibilityHandler({ roomId: "!room:ex.com", historyVisibility: "invited" as any }, reqContext);
    expect(result.isError).toBeUndefined();
    expect(client.sendStateEvent).toHaveBeenCalledWith("!room:ex.com", "m.room.history_visibility", { history_visibility: "invited" });
  });

  it("returns error when room not found", async () => {
    const client = { getRoom: () => null, sendStateEvent: jest.fn() };
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setHistoryVisibilityHandler({ roomId: "!missing:ex.com", historyVisibility: "shared" as any }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error when insufficient permissions", async () => {
    const room = mockRoom({ userPowerLevel: 0, requiredLevel: 50 });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setHistoryVisibilityHandler({ roomId: "!room:ex.com", historyVisibility: "shared" as any }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission");
  });

  it("handles M_FORBIDDEN errors", async () => {
    const room = mockRoom({});
    const client = mockClient(room);
    client.sendStateEvent.mockRejectedValue(new Error("M_FORBIDDEN: not allowed") as never);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setHistoryVisibilityHandler({ roomId: "!room:ex.com", historyVisibility: "joined" as any }, reqContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission");
  });

  it("includes room name in success message", async () => {
    const room = mockRoom({ name: "My Custom Room", historyVisibility: "joined" });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await setHistoryVisibilityHandler({ roomId: "!room:ex.com", historyVisibility: "shared" as any }, reqContext);
    expect(result.content[0].text).toContain("My Custom Room");
  });
});
