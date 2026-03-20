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
const { redactEventHandler, sendReactionHandler, editMessageHandler } = await import("./message-actions.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function mockClient(overrides: Record<string, any> = {}) {
  return {
    redactEvent: jest.fn<any>().mockResolvedValue({}),
    sendEvent: jest.fn<any>().mockResolvedValue({ event_id: "$new_event" }),
    ...overrides,
  };
}

describe("redactEventHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("redacts an event successfully", async () => {
    const client = mockClient();
    mockCreateClient.mockResolvedValue(client as any);

    const result = await redactEventHandler(
      { roomId: "!room:ex.com", eventId: "$evt1" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("redacted successfully");
    expect(result.content[0].text).toContain("$evt1");
    expect(client.redactEvent).toHaveBeenCalledWith("!room:ex.com", "$evt1", undefined, undefined);
  });

  it("includes reason when provided", async () => {
    const client = mockClient();
    mockCreateClient.mockResolvedValue(client as any);

    const result = await redactEventHandler(
      { roomId: "!room:ex.com", eventId: "$evt1", reason: "spam" },
      reqContext
    );
    expect(result.content[0].text).toContain("Reason: spam");
    expect(client.redactEvent).toHaveBeenCalledWith("!room:ex.com", "$evt1", undefined, { reason: "spam" });
  });

  it("returns error with diagnostic hint on failure", async () => {
    const client = mockClient({
      redactEvent: jest.fn<any>().mockRejectedValue(new Error("M_FORBIDDEN")),
    });
    mockCreateClient.mockResolvedValue(client as any);

    const result = await redactEventHandler(
      { roomId: "!room:ex.com", eventId: "$evt1" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("M_FORBIDDEN");
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("sendReactionHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends a reaction successfully", async () => {
    const client = mockClient();
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendReactionHandler(
      { roomId: "!room:ex.com", eventId: "$evt1", emoji: "👍" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("👍");
    expect(result.content[0].text).toContain("$new_event");
    expect(client.sendEvent).toHaveBeenCalledWith("!room:ex.com", "m.reaction", {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$evt1",
        key: "👍",
      },
    });
  });

  it("returns error with diagnostic hint on failure", async () => {
    const client = mockClient({
      sendEvent: jest.fn<any>().mockRejectedValue(new Error("M_NOT_FOUND")),
    });
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendReactionHandler(
      { roomId: "!room:ex.com", eventId: "$evt1", emoji: "❤️" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to send reaction");
  });
});

describe("editMessageHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("edits a message successfully", async () => {
    const client = mockClient();
    mockCreateClient.mockResolvedValue(client as any);

    const result = await editMessageHandler(
      { roomId: "!room:ex.com", eventId: "$orig", newBody: "updated text" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("edited successfully");
    expect(result.content[0].text).toContain("$orig");
    expect(result.content[0].text).toContain("$new_event");
    expect(client.sendEvent).toHaveBeenCalledWith("!room:ex.com", "m.room.message", {
      msgtype: "m.text",
      body: "* updated text",
      "m.new_content": { msgtype: "m.text", body: "updated text" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
    });
  });

  it("returns error with diagnostic hint on failure", async () => {
    const client = mockClient({
      sendEvent: jest.fn<any>().mockRejectedValue(new Error("M_FORBIDDEN")),
    });
    mockCreateClient.mockResolvedValue(client as any);

    const result = await editMessageHandler(
      { roomId: "!room:ex.com", eventId: "$orig", newBody: "nope" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to edit message");
    expect(result.content[0].text).toContain("get-server-health");
  });
});
