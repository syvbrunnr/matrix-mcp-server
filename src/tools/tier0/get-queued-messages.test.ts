import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { QueuedMessage, QueuedReaction, QueuedInvite, QueueContents, MessageQueue } from "../../matrix/messageQueue.js";

const mockDequeue = jest.fn<(roomId?: string) => QueueContents>();
const mockGetContext = jest.fn<(roomIds: string[], limit: number, excludeEventIds: Set<string>) => Map<string, QueuedMessage[]>>();

jest.unstable_mockModule("../../matrix/messageQueue.js", () => ({
  getMessageQueue: jest.fn(() => ({
    dequeue: mockDequeue,
    getContext: mockGetContext,
  })),
}));

const { getQueuedMessagesHandler } = await import("./get-queued-messages.js");

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

function makeMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    eventId: "$evt1",
    roomId: "!room1:example.com",
    roomName: "General",
    sender: "@alice:example.com",
    body: "Hello",
    timestamp: 1700000000000,
    isDM: false,
    ...overrides,
  };
}

function makeReaction(overrides: Partial<QueuedReaction> = {}): QueuedReaction {
  return {
    eventId: "$react1",
    roomId: "!room1:example.com",
    roomName: "General",
    sender: "@bob:example.com",
    emoji: "👍",
    reactedToEventId: "$evt1",
    timestamp: 1700000001000,
    ...overrides,
  };
}

function makeInvite(overrides: Partial<QueuedInvite> = {}): QueuedInvite {
  return {
    roomId: "!newroom:example.com",
    roomName: "New Room",
    invitedBy: "@charlie:example.com",
    timestamp: 1700000002000,
    ...overrides,
  };
}

describe("getQueuedMessagesHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContext.mockReturnValue(new Map());
  });

  it("returns empty counts when queue is empty", async () => {
    mockDequeue.mockReturnValue({ messages: [], reactions: [], invites: [] });

    const result = parseResult(await getQueuedMessagesHandler({}));

    expect(result.messageCount).toBe(0);
    expect(result.reactionCount).toBe(0);
    expect(result.inviteCount).toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.reactions).toEqual([]);
    expect(result.invites).toEqual([]);
    expect(result.context).toBeUndefined();
  });

  it("passes roomId filter to dequeue", async () => {
    mockDequeue.mockReturnValue({ messages: [], reactions: [], invites: [] });

    await getQueuedMessagesHandler({ roomId: "!specific:example.com" });

    expect(mockDequeue).toHaveBeenCalledWith("!specific:example.com");
  });

  it("maps messages with all required fields and ISO timestamps", async () => {
    const msg = makeMessage();
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 0 }));

    expect(result.messageCount).toBe(1);
    expect(result.messages[0]).toEqual({
      eventId: "$evt1",
      room: "General",
      roomId: "!room1:example.com",
      sender: "@alice:example.com",
      body: "Hello",
      timestamp: new Date(1700000000000).toISOString(),
      isDM: false,
    });
  });

  it("includes optional message fields when present", async () => {
    const msg = makeMessage({
      threadRootEventId: "$thread1",
      replyToEventId: "$reply1",
      decryptionFailed: true,
      decryptionFailureReason: "OLM_BAD_SESSION",
      editedOriginalEventId: "$orig1",
    });
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 0 }));
    const m = result.messages[0];

    expect(m.threadRootEventId).toBe("$thread1");
    expect(m.replyToEventId).toBe("$reply1");
    expect(m.decryptionFailed).toBe(true);
    expect(m.decryptionFailureReason).toBe("OLM_BAD_SESSION");
    expect(m.editedOriginalEventId).toBe("$orig1");
  });

  it("maps reactions with correct fields", async () => {
    const reaction = makeReaction();
    mockDequeue.mockReturnValue({ messages: [], reactions: [reaction], invites: [] });

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 0 }));

    expect(result.reactionCount).toBe(1);
    expect(result.reactions[0]).toEqual({
      eventId: "$react1",
      room: "General",
      roomId: "!room1:example.com",
      sender: "@bob:example.com",
      emoji: "👍",
      reactedToEventId: "$evt1",
      timestamp: new Date(1700000001000).toISOString(),
    });
  });

  it("maps invites with correct fields", async () => {
    const invite = makeInvite();
    mockDequeue.mockReturnValue({ messages: [], reactions: [], invites: [invite] });

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 0 }));

    expect(result.inviteCount).toBe(1);
    expect(result.invites[0]).toEqual({
      roomId: "!newroom:example.com",
      roomName: "New Room",
      invitedBy: "@charlie:example.com",
      timestamp: new Date(1700000002000).toISOString(),
    });
  });

  it("fetches context when contextMessages > 0 and messages exist", async () => {
    const msg = makeMessage();
    const ctxMsg = makeMessage({ eventId: "$ctx1", body: "Earlier message", timestamp: 1699999999000 });
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });
    mockGetContext.mockReturnValue(new Map([["!room1:example.com", [ctxMsg]]]));

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 5 }));

    expect(mockGetContext).toHaveBeenCalledWith(
      ["!room1:example.com"],
      5,
      new Set(["$evt1"]),
    );
    expect(result.context).toBeDefined();
    expect(result.context["General"]).toEqual([
      {
        sender: "@alice:example.com",
        body: "Earlier message",
        timestamp: new Date(1699999999000).toISOString(),
      },
    ]);
  });

  it("does not fetch context when contextMessages is 0", async () => {
    const msg = makeMessage();
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 0 }));

    expect(mockGetContext).not.toHaveBeenCalled();
    expect(result.context).toBeUndefined();
  });

  it("does not fetch context when there are no messages even if contextMessages > 0", async () => {
    mockDequeue.mockReturnValue({ messages: [], reactions: [makeReaction()], invites: [] });

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 5 }));

    expect(mockGetContext).not.toHaveBeenCalled();
    expect(result.context).toBeUndefined();
  });

  it("clamps contextMessages to [0, 10] range", async () => {
    const msg = makeMessage();
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });
    mockGetContext.mockReturnValue(new Map());

    // Above 10 should clamp to 10
    await getQueuedMessagesHandler({ contextMessages: 50 });
    expect(mockGetContext).toHaveBeenCalledWith(
      ["!room1:example.com"],
      10,
      expect.any(Set),
    );

    mockGetContext.mockClear();
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });

    // Negative should clamp to 0, which means no context call
    await getQueuedMessagesHandler({ contextMessages: -5 });
    expect(mockGetContext).not.toHaveBeenCalled();
  });

  it("uses roomName from dequeued messages for context keys", async () => {
    const msg = makeMessage({ roomId: "!room1:example.com", roomName: "My Custom Room" });
    const ctxMsg = makeMessage({ eventId: "$ctx1", body: "context", timestamp: 1699999999000 });
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });
    mockGetContext.mockReturnValue(new Map([["!room1:example.com", [ctxMsg]]]));

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 3 }));

    expect(result.context["My Custom Room"]).toBeDefined();
    expect(result.context["!room1:example.com"]).toBeUndefined();
  });

  it("defaults contextMessages to 3 when not provided", async () => {
    const msg = makeMessage();
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });
    mockGetContext.mockReturnValue(new Map());

    await getQueuedMessagesHandler({});

    expect(mockGetContext).toHaveBeenCalledWith(
      ["!room1:example.com"],
      3,
      expect.any(Set),
    );
  });

  it("omits context key from output when getContext returns empty map", async () => {
    const msg = makeMessage();
    mockDequeue.mockReturnValue({ messages: [msg], reactions: [], invites: [] });
    mockGetContext.mockReturnValue(new Map());

    const result = parseResult(await getQueuedMessagesHandler({ contextMessages: 3 }));

    expect(result.context).toBeUndefined();
  });
});
