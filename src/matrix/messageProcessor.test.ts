import { countMessagesByUser } from "./messageProcessor.js";
import { EventType } from "matrix-js-sdk";

// Helper to create mock Matrix events
function mockEvent(opts: {
  type?: string;
  sender?: string;
  body?: string;
  ts?: number;
  id?: string;
}) {
  return {
    getType: () => opts.type ?? EventType.RoomMessage,
    getSender: () => opts.sender ?? "@user:example.com",
    getTs: () => opts.ts ?? Date.now(),
    getId: () => opts.id ?? "$evt_" + Math.random().toString(36).slice(2),
    getContent: () => ({ body: opts.body ?? "hello", msgtype: "m.text" }),
    getClearContent: () => null,
    isRedacted: () => false,
    isDecryptionFailure: () => false,
  } as any;
}

describe("countMessagesByUser", () => {
  it("counts messages grouped by sender", () => {
    const events = [
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@bob:ex.com" }),
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@bob:ex.com" }),
    ];

    const result = countMessagesByUser(events);
    expect(result).toEqual([
      { userId: "@alice:ex.com", count: 3 },
      { userId: "@bob:ex.com", count: 2 },
    ]);
  });

  it("respects limit parameter", () => {
    const events = [
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@bob:ex.com" }),
      mockEvent({ sender: "@charlie:ex.com" }),
    ];

    const result = countMessagesByUser(events, 1);
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe("@alice:ex.com");
  });

  it("returns empty array for no events", () => {
    expect(countMessagesByUser([])).toEqual([]);
  });

  it("ignores non-message events", () => {
    const events = [
      mockEvent({ sender: "@alice:ex.com", type: EventType.RoomMessage }),
      mockEvent({ sender: "@alice:ex.com", type: "m.room.member" }),
      mockEvent({ sender: "@bob:ex.com", type: "m.room.topic" }),
    ];

    const result = countMessagesByUser(events);
    expect(result).toEqual([{ userId: "@alice:ex.com", count: 1 }]);
  });

  it("counts encrypted messages", () => {
    const events = [
      mockEvent({ sender: "@alice:ex.com", type: EventType.RoomMessageEncrypted }),
      mockEvent({ sender: "@alice:ex.com", type: EventType.RoomMessage }),
    ];

    const result = countMessagesByUser(events);
    expect(result).toEqual([{ userId: "@alice:ex.com", count: 2 }]);
  });

  it("sorts by count descending", () => {
    const events = [
      mockEvent({ sender: "@charlie:ex.com" }),
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@alice:ex.com" }),
      mockEvent({ sender: "@bob:ex.com" }),
      mockEvent({ sender: "@bob:ex.com" }),
    ];

    const result = countMessagesByUser(events);
    expect(result[0].userId).toBe("@alice:ex.com");
    expect(result[1].userId).toBe("@bob:ex.com");
    expect(result[2].userId).toBe("@charlie:ex.com");
  });

  it("defaults limit to 10", () => {
    // Create 12 unique users
    const events = Array.from({ length: 12 }, (_, i) =>
      mockEvent({ sender: `@user${i}:ex.com` })
    );

    const result = countMessagesByUser(events);
    expect(result).toHaveLength(10);
  });
});
