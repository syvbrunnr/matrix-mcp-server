import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../matrix/messageQueue.js", () => ({
  getMessageQueue: jest.fn(),
}));

const { getMessageQueue } = await import("../../matrix/messageQueue.js");
const { replayQueueHandler } = await import("./replay-queue.js");

const mockGetMessageQueue = getMessageQueue as jest.MockedFunction<typeof getMessageQueue>;

function mockQueue(messages: any[] = [], reactions: any[] = [], invites: any[] = []) {
  mockGetMessageQueue.mockReturnValue({
    replaySince: jest.fn().mockReturnValue({ messages, reactions, invites }),
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("replayQueueHandler", () => {
  it("returns isError=true when timestamp is invalid", async () => {
    const result = await replayQueueHandler({ sinceTimestamp: "not-a-date" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/Invalid timestamp/);
  });

  it("returns isError=true for empty string timestamp", async () => {
    const result = await replayQueueHandler({ sinceTimestamp: "" });
    expect(result.isError).toBe(true);
  });

  it("calls replaySince with parsed milliseconds and no roomId", async () => {
    mockQueue();
    const ts = "2026-03-07T10:00:00Z";
    await replayQueueHandler({ sinceTimestamp: ts });

    const queue = mockGetMessageQueue.mock.results[0].value;
    expect(queue.replaySince).toHaveBeenCalledWith(
      new Date(ts).getTime(),
      undefined
    );
  });

  it("passes roomId through to replaySince", async () => {
    mockQueue();
    const ts = "2026-03-07T10:00:00Z";
    const roomId = "!myroom:example.com";
    await replayQueueHandler({ sinceTimestamp: ts, roomId });

    const queue = mockGetMessageQueue.mock.results[0].value;
    expect(queue.replaySince).toHaveBeenCalledWith(
      new Date(ts).getTime(),
      roomId
    );
  });

  it("returns empty arrays when nothing to replay", async () => {
    mockQueue();
    const result = await replayQueueHandler({ sinceTimestamp: "2026-03-07T10:00:00Z" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.messageCount).toBe(0);
    expect(parsed.reactionCount).toBe(0);
    expect(parsed.inviteCount).toBe(0);
    expect(parsed.messages).toEqual([]);
    expect(parsed.reactions).toEqual([]);
    expect(parsed.invites).toEqual([]);
    expect(parsed.replayedSince).toBe("2026-03-07T10:00:00Z");
  });

  it("maps messages with all fields including optional ones", async () => {
    const ts = 1709800000000;
    mockQueue([
      {
        eventId: "$msg1",
        roomId: "!room:example.com",
        roomName: "General",
        sender: "@alice:example.com",
        body: "hello world",
        timestamp: ts,
        isDM: true,
        threadRootEventId: "$thread1",
        replyToEventId: "$reply1",
        decryptionFailed: true,
        decryptionFailureReason: "OLM_UNKNOWN_MESSAGE_INDEX",
      },
    ]);

    const result = await replayQueueHandler({ sinceTimestamp: "2026-03-07T10:00:00Z" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.messageCount).toBe(1);
    const msg = parsed.messages[0];
    expect(msg.eventId).toBe("$msg1");
    expect(msg.room).toBe("General");
    expect(msg.roomId).toBe("!room:example.com");
    expect(msg.sender).toBe("@alice:example.com");
    expect(msg.body).toBe("hello world");
    expect(msg.timestamp).toBe(new Date(ts).toISOString());
    expect(msg.isDM).toBe(true);
    expect(msg.threadRootEventId).toBe("$thread1");
    expect(msg.replyToEventId).toBe("$reply1");
    expect(msg.decryptionFailed).toBe(true);
    expect(msg.decryptionFailureReason).toBe("OLM_UNKNOWN_MESSAGE_INDEX");
  });

  it("omits optional message fields when not present", async () => {
    mockQueue([
      {
        eventId: "$msg2",
        roomId: "!room:example.com",
        roomName: "General",
        sender: "@bob:example.com",
        body: "simple message",
        timestamp: Date.now(),
        isDM: false,
      },
    ]);

    const result = await replayQueueHandler({ sinceTimestamp: "2026-03-07T10:00:00Z" });
    const parsed = JSON.parse(result.content[0].text);
    const msg = parsed.messages[0];

    expect(msg.threadRootEventId).toBeUndefined();
    expect(msg.replyToEventId).toBeUndefined();
    expect(msg.decryptionFailed).toBeUndefined();
    expect(msg.decryptionFailureReason).toBeUndefined();
  });

  it("maps reactions correctly", async () => {
    const ts = 1709800000000;
    mockQueue([], [
      {
        eventId: "$react1",
        roomId: "!room:example.com",
        roomName: "General",
        sender: "@bob:example.com",
        emoji: "thumbsup",
        reactedToEventId: "$target1",
        timestamp: ts,
      },
    ]);

    const result = await replayQueueHandler({ sinceTimestamp: "2026-03-07T10:00:00Z" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.reactionCount).toBe(1);
    const reaction = parsed.reactions[0];
    expect(reaction.eventId).toBe("$react1");
    expect(reaction.room).toBe("General");
    expect(reaction.roomId).toBe("!room:example.com");
    expect(reaction.sender).toBe("@bob:example.com");
    expect(reaction.emoji).toBe("thumbsup");
    expect(reaction.reactedToEventId).toBe("$target1");
    expect(reaction.timestamp).toBe(new Date(ts).toISOString());
  });

  it("maps invites correctly", async () => {
    const ts = 1709800000000;
    mockQueue([], [], [
      {
        roomId: "!newroom:example.com",
        roomName: "New Room",
        invitedBy: "@admin:example.com",
        timestamp: ts,
      },
    ]);

    const result = await replayQueueHandler({ sinceTimestamp: "2026-03-07T10:00:00Z" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.inviteCount).toBe(1);
    const invite = parsed.invites[0];
    expect(invite.roomId).toBe("!newroom:example.com");
    expect(invite.roomName).toBe("New Room");
    expect(invite.invitedBy).toBe("@admin:example.com");
    expect(invite.timestamp).toBe(new Date(ts).toISOString());
  });

  it("returns correct counts with mixed content", async () => {
    const ts = Date.now();
    mockQueue(
      [
        { eventId: "$m1", roomId: "!r:e", roomName: "R", sender: "@a:e", body: "a", timestamp: ts, isDM: false },
        { eventId: "$m2", roomId: "!r:e", roomName: "R", sender: "@b:e", body: "b", timestamp: ts, isDM: false },
      ],
      [
        { eventId: "$rx1", roomId: "!r:e", roomName: "R", sender: "@a:e", emoji: "+1", reactedToEventId: "$m1", timestamp: ts },
      ],
      [
        { roomId: "!n:e", roomName: "N", invitedBy: "@c:e", timestamp: ts },
        { roomId: "!n2:e", roomName: "N2", invitedBy: "@c:e", timestamp: ts },
      ]
    );

    const result = await replayQueueHandler({ sinceTimestamp: "2026-03-07T10:00:00Z" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.messageCount).toBe(2);
    expect(parsed.reactionCount).toBe(1);
    expect(parsed.inviteCount).toBe(2);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.reactions).toHaveLength(1);
    expect(parsed.invites).toHaveLength(2);
  });
});
