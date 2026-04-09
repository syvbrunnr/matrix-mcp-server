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

jest.unstable_mockModule("../../utils/threading.js", () => ({
  resolveThreadRoot: jest.fn<any>().mockReturnValue(undefined),
  buildRelatesTo: jest.fn<any>().mockReturnValue(undefined),
}));

// Dynamic imports after mocks
const { createConfiguredMatrixClient } = await import("../../utils/server-helpers.js");
const { sendMessageHandler, sendImageHandler } = await import("./messaging.js");

const mockCreateClient = createConfiguredMatrixClient as jest.MockedFunction<typeof createConfiguredMatrixClient>;
const reqContext = { requestInfo: { headers: {} }, authInfo: { token: "tok" } };

function mockRoom(opts: { name?: string; memberCount?: number; userPowerLevel?: number; requiredLevel?: number; encrypted?: boolean } = {}) {
  return {
    name: opts.name ?? "Test Room",
    roomId: "!room:ex.com",
    getJoinedMemberCount: () => opts.memberCount ?? 3,
    getMember: (_userId: string) => ({ powerLevel: opts.userPowerLevel ?? 100 }),
    currentState: {
      getStateEvents: (type: string, _key: string) => {
        if (type === "m.room.power_levels") {
          return {
            getContent: () => ({
              events: { "m.room.message": opts.requiredLevel ?? 0 },
            }),
          };
        }
        return null;
      },
    },
    findEventById: () => null,
    hasEncryptionStateEvent: () => opts.encrypted ?? false,
  };
}

function mockClient(room: any, overrides: Record<string, any> = {}) {
  return {
    getRoom: (_id: string) => room,
    sendTextMessage: jest.fn<any>().mockResolvedValue({ event_id: "$sent1" }),
    sendHtmlMessage: jest.fn<any>().mockResolvedValue({ event_id: "$sent2" }),
    sendEmoteMessage: jest.fn<any>().mockResolvedValue({ event_id: "$sent3" }),
    sendEvent: jest.fn<any>().mockResolvedValue({ event_id: "$sent4" }),
    uploadContent: jest.fn<any>().mockResolvedValue({ content_uri: "mxc://example.com/abc" }),
    ...overrides,
  };
}

describe("sendMessageHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends a plain text message", async () => {
    const room = mockRoom();
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendMessageHandler(
      { roomId: "!room:ex.com", message: "hello", messageType: "text" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("sent successfully");
    expect(result.content[0].text).toContain("Test Room");
    expect(client.sendTextMessage).toHaveBeenCalledWith("!room:ex.com", "hello");
  });

  it("sends an HTML message", async () => {
    const room = mockRoom();
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendMessageHandler(
      { roomId: "!room:ex.com", message: "<b>bold</b>", messageType: "html" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(client.sendHtmlMessage).toHaveBeenCalled();
  });

  it("sends an emote message", async () => {
    const room = mockRoom();
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendMessageHandler(
      { roomId: "!room:ex.com", message: "waves", messageType: "emote" },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(client.sendEmoteMessage).toHaveBeenCalledWith("!room:ex.com", "waves");
  });

  it("returns error when room not found", async () => {
    const client = mockClient(null, { getRoom: () => null });
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendMessageHandler(
      { roomId: "!missing:ex.com", message: "hi", messageType: "text" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error when insufficient power level", async () => {
    const room = mockRoom({ userPowerLevel: 0, requiredLevel: 50 });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendMessageHandler(
      { roomId: "!room:ex.com", message: "hi", messageType: "text" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission");
  });

  it("returns error with diagnostic hint on SDK failure", async () => {
    const room = mockRoom();
    const client = mockClient(room, {
      sendTextMessage: jest.fn<any>().mockRejectedValue(new Error("M_FORBIDDEN")),
    });
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendMessageHandler(
      { roomId: "!room:ex.com", message: "hi", messageType: "text" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to send message");
    expect(result.content[0].text).toContain("get-server-health");
  });
});

describe("sendImageHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends an image successfully", async () => {
    const room = mockRoom();
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    // Small 1x1 pixel PNG in base64
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const result = await sendImageHandler(
      { roomId: "!room:ex.com", imageBase64: tinyPng },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Image sent successfully");
    expect(result.content[0].text).toContain("mxc://example.com/abc");
    expect(client.uploadContent).toHaveBeenCalled();
    expect(client.sendEvent).toHaveBeenCalled();
  });

  it("sends an encrypted image in an E2EE room (file + thumbnail_file + key material)", async () => {
    const room = mockRoom({ encrypted: true });
    const client = mockClient(room);
    mockCreateClient.mockResolvedValue(client as any);

    // Small 1x1 pixel PNG in base64
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const result = await sendImageHandler(
      { roomId: "!room:ex.com", imageBase64: tinyPng },
      reqContext
    );
    expect(result.isError).toBeUndefined();
    // uploadContent is called twice: once for main file, once for thumbnail.
    expect((client.uploadContent as jest.Mock).mock.calls.length).toBe(2);
    const mainUpload = (client.uploadContent as jest.Mock).mock.calls[0];
    expect(mainUpload[1].type).toBe("application/octet-stream");
    const thumbUpload = (client.uploadContent as jest.Mock).mock.calls[1];
    expect(thumbUpload[1].type).toBe("application/octet-stream");
    expect(thumbUpload[1].name).toContain("thumb");

    const sendCall = (client.sendEvent as jest.Mock).mock.calls[0];
    const content = sendCall[2];
    // Encrypted rooms use content.file with key material, not content.url.
    expect(content.url).toBeUndefined();
    expect(content.file).toBeDefined();
    expect(content.file.v).toBe("v2");
    expect(content.file.url).toBe("mxc://example.com/abc");
    expect(content.file.key.alg).toBe("A256CTR");
    expect(content.file.key.k).toBeDefined();
    expect(content.file.iv).toBeDefined();
    expect(content.file.hashes.sha256).toBeDefined();
    expect(content.file.mimetype).toBe("image/png");
    // info should carry width/height from PNG header.
    expect(content.info.w).toBe(1);
    expect(content.info.h).toBe(1);
    // info.thumbnail_file is required by Element Desktop for inline rendering
    // in encrypted rooms.
    expect(content.info.thumbnail_file).toBeDefined();
    expect(content.info.thumbnail_file.v).toBe("v2");
    expect(content.info.thumbnail_file.url).toBe("mxc://example.com/abc");
    expect(content.info.thumbnail_file.key.alg).toBe("A256CTR");
    expect(content.info.thumbnail_file.mimetype).toBe("image/png");
    // Thumbnail has its own fresh IV (distinct from main file IV).
    expect(content.info.thumbnail_file.iv).not.toBe(content.file.iv);
    expect(content.info.thumbnail_info).toBeDefined();
    expect(content.info.thumbnail_info.w).toBe(1);
    expect(content.info.thumbnail_info.h).toBe(1);
    expect(content.info.thumbnail_info.mimetype).toBe("image/png");
  });

  it("returns error when room not found", async () => {
    const client = mockClient(null, { getRoom: () => null });
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendImageHandler(
      { roomId: "!missing:ex.com", imageBase64: "abc" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error with diagnostic hint on upload failure", async () => {
    const room = mockRoom();
    const client = mockClient(room, {
      uploadContent: jest.fn<any>().mockRejectedValue(new Error("Upload failed")),
    });
    mockCreateClient.mockResolvedValue(client as any);

    const result = await sendImageHandler(
      { roomId: "!room:ex.com", imageBase64: "abc" },
      reqContext
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to send image");
    expect(result.content[0].text).toContain("get-server-health");
  });
});
