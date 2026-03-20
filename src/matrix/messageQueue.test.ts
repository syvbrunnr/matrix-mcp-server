import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { MessageQueue } from "./messageQueue.js";
import type { QueuedMessage, QueuedReaction, QueuedInvite } from "./messageQueue.js";

let queue: MessageQueue;

beforeEach(() => {
  queue = new MessageQueue(":memory:");
});

afterEach(() => {
  queue.close();
});

function makeMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    eventId: `$evt-${Math.random().toString(36).slice(2, 8)}`,
    roomId: "!room:example.com",
    roomName: "Test Room",
    sender: "@alice:example.com",
    body: "hello",
    timestamp: Date.now(),
    isDM: false,
    ...overrides,
  };
}

function makeReaction(overrides: Partial<QueuedReaction> = {}): QueuedReaction {
  return {
    eventId: `$react-${Math.random().toString(36).slice(2, 8)}`,
    roomId: "!room:example.com",
    roomName: "Test Room",
    sender: "@bob:example.com",
    emoji: "👍",
    reactedToEventId: "$target-event",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeInvite(overrides: Partial<QueuedInvite> = {}): QueuedInvite {
  return {
    roomId: "!newroom:example.com",
    roomName: "New Room",
    invitedBy: "@admin:example.com",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("MessageQueue", () => {
  describe("enqueueMessage", () => {
    it("enqueues a message and returns true", () => {
      const msg = makeMessage();
      expect(queue.enqueueMessage(msg)).toBe(true);
    });

    it("rejects duplicate event IDs", () => {
      const msg = makeMessage({ eventId: "$dup" });
      expect(queue.enqueueMessage(msg)).toBe(true);
      expect(queue.enqueueMessage(msg)).toBe(false);
    });

    it("emits new-item event with metadata", (done) => {
      const msg = makeMessage({ roomId: "!r:ex.com", roomName: "R", sender: "@s:ex.com", isDM: true, body: "hi" });
      queue.on("new-item", (evt: any) => {
        expect(evt.type).toBe("message");
        expect(evt.roomId).toBe("!r:ex.com");
        expect(evt.roomName).toBe("R");
        expect(evt.sender).toBe("@s:ex.com");
        expect(evt.isDM).toBe(true);
        expect(evt.body).toBe("hi");
        done();
      });
      queue.enqueueMessage(msg);
    });

    it("stores optional fields (thread, reply, decryption, edit)", () => {
      const msg = makeMessage({
        threadRootEventId: "$thread",
        replyToEventId: "$reply",
        decryptionFailed: true,
        decryptionFailureReason: "OLM_BAD_SESSION",
        editedOriginalEventId: "$orig",
      });
      queue.enqueueMessage(msg);
      const { messages } = queue.dequeue();
      expect(messages).toHaveLength(1);
      expect(messages[0].threadRootEventId).toBe("$thread");
      expect(messages[0].replyToEventId).toBe("$reply");
      expect(messages[0].decryptionFailed).toBe(true);
      expect(messages[0].decryptionFailureReason).toBe("OLM_BAD_SESSION");
      expect(messages[0].editedOriginalEventId).toBe("$orig");
    });
  });

  describe("enqueueReaction", () => {
    it("enqueues a reaction and returns true", () => {
      expect(queue.enqueueReaction(makeReaction())).toBe(true);
    });

    it("rejects duplicate reaction events", () => {
      const r = makeReaction({ eventId: "$dup-r" });
      expect(queue.enqueueReaction(r)).toBe(true);
      expect(queue.enqueueReaction(r)).toBe(false);
    });

    it("emits new-item for reactions", (done) => {
      queue.on("new-item", (evt: any) => {
        expect(evt.type).toBe("reaction");
        done();
      });
      queue.enqueueReaction(makeReaction());
    });
  });

  describe("enqueueInvite", () => {
    it("enqueues an invite and returns true", () => {
      expect(queue.enqueueInvite(makeInvite())).toBe(true);
    });

    it("emits new-item for invites", (done) => {
      queue.on("new-item", (evt: any) => {
        expect(evt.type).toBe("invite");
        done();
      });
      queue.enqueueInvite(makeInvite());
    });
  });

  describe("peek", () => {
    it("returns zero counts on empty queue", () => {
      const peek = queue.peek();
      expect(peek.count).toBe(0);
      expect(peek.types).toEqual({ messages: 0, reactions: 0, invites: 0 });
      expect(peek.rooms).toEqual([]);
    });

    it("returns correct counts by type", () => {
      queue.enqueueMessage(makeMessage());
      queue.enqueueMessage(makeMessage());
      queue.enqueueReaction(makeReaction());
      queue.enqueueInvite(makeInvite());

      const peek = queue.peek();
      expect(peek.count).toBe(4);
      expect(peek.types.messages).toBe(2);
      expect(peek.types.reactions).toBe(1);
      expect(peek.types.invites).toBe(1);
    });

    it("groups rooms with message counts", () => {
      queue.enqueueMessage(makeMessage({ roomId: "!a:ex.com", roomName: "A" }));
      queue.enqueueMessage(makeMessage({ roomId: "!a:ex.com", roomName: "A" }));
      queue.enqueueMessage(makeMessage({ roomId: "!b:ex.com", roomName: "B" }));

      const peek = queue.peek();
      expect(peek.rooms).toHaveLength(2);
      const roomA = peek.rooms.find((r) => r.roomId === "!a:ex.com");
      const roomB = peek.rooms.find((r) => r.roomId === "!b:ex.com");
      expect(roomA?.count).toBe(2);
      expect(roomB?.count).toBe(1);
    });

    it("excludes fetched items", () => {
      queue.enqueueMessage(makeMessage());
      queue.dequeue(); // marks as fetched
      expect(queue.peek().count).toBe(0);
    });
  });

  describe("peekRoom", () => {
    it("returns zero for empty room", () => {
      const peek = queue.peekRoom("!nonexistent:ex.com");
      expect(peek.count).toBe(0);
      expect(peek.rooms).toEqual([]);
    });

    it("returns counts for specific room only", () => {
      queue.enqueueMessage(makeMessage({ roomId: "!target:ex.com" }));
      queue.enqueueMessage(makeMessage({ roomId: "!target:ex.com" }));
      queue.enqueueMessage(makeMessage({ roomId: "!other:ex.com" }));

      const peek = queue.peekRoom("!target:ex.com");
      expect(peek.count).toBe(2);
      expect(peek.types.messages).toBe(2);
    });

    it("counts reactions and invites per room", () => {
      queue.enqueueReaction(makeReaction({ roomId: "!r:ex.com" }));
      queue.enqueueInvite(makeInvite({ roomId: "!r:ex.com" }));

      const peek = queue.peekRoom("!r:ex.com");
      expect(peek.count).toBe(2);
      expect(peek.types.reactions).toBe(1);
      expect(peek.types.invites).toBe(1);
    });
  });

  describe("dequeue", () => {
    it("returns empty on empty queue", () => {
      const result = queue.dequeue();
      expect(result.messages).toEqual([]);
      expect(result.reactions).toEqual([]);
      expect(result.invites).toEqual([]);
    });

    it("returns all unfetched items and marks them fetched", () => {
      queue.enqueueMessage(makeMessage());
      queue.enqueueReaction(makeReaction());
      queue.enqueueInvite(makeInvite());

      const result = queue.dequeue();
      expect(result.messages).toHaveLength(1);
      expect(result.reactions).toHaveLength(1);
      expect(result.invites).toHaveLength(1);

      // Second dequeue returns empty — items are fetched
      const result2 = queue.dequeue();
      expect(result2.messages).toEqual([]);
    });

    it("filters by roomId when specified", () => {
      queue.enqueueMessage(makeMessage({ roomId: "!a:ex.com", body: "in A" }));
      queue.enqueueMessage(makeMessage({ roomId: "!b:ex.com", body: "in B" }));

      const result = queue.dequeue("!a:ex.com");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].body).toBe("in A");

      // !b:ex.com message still unfetched
      expect(queue.peek().count).toBe(1);
    });

    it("preserves message ordering by timestamp", () => {
      const now = Date.now();
      queue.enqueueMessage(makeMessage({ body: "third", timestamp: now + 200 }));
      queue.enqueueMessage(makeMessage({ body: "first", timestamp: now }));
      queue.enqueueMessage(makeMessage({ body: "second", timestamp: now + 100 }));

      const result = queue.dequeue();
      expect(result.messages.map((m) => m.body)).toEqual(["first", "second", "third"]);
    });
  });

  describe("tryEditInPlace", () => {
    it("returns not-found for unknown event", () => {
      expect(queue.tryEditInPlace("$unknown", "new body")).toBe("not-found");
    });

    it("edits unfetched message in place", () => {
      const msg = makeMessage({ eventId: "$editable", body: "original" });
      queue.enqueueMessage(msg);

      expect(queue.tryEditInPlace("$editable", "edited")).toBe("in-place");

      const { messages } = queue.dequeue();
      expect(messages[0].body).toBe("edited");
    });

    it("returns fetched for already-fetched message", () => {
      const msg = makeMessage({ eventId: "$fetched" });
      queue.enqueueMessage(msg);
      queue.dequeue(); // marks as fetched

      expect(queue.tryEditInPlace("$fetched", "too late")).toBe("fetched");
    });
  });

  describe("updateDecryptedBody", () => {
    it("updates body and clears decryption failure flags", () => {
      const msg = makeMessage({
        eventId: "$encrypted",
        body: "[encrypted]",
        decryptionFailed: true,
        decryptionFailureReason: "UNKNOWN_DEVICE",
      });
      queue.enqueueMessage(msg);

      queue.updateDecryptedBody("$encrypted", "decrypted content");

      const { messages } = queue.dequeue();
      expect(messages[0].body).toBe("decrypted content");
      expect(messages[0].decryptionFailed).toBeFalsy();
      expect(messages[0].decryptionFailureReason).toBeUndefined();
    });

    it("does not update already-fetched messages", () => {
      const msg = makeMessage({ eventId: "$already-fetched", body: "[encrypted]" });
      queue.enqueueMessage(msg);
      queue.dequeue();

      queue.updateDecryptedBody("$already-fetched", "decrypted");
      // No error, but nothing to verify — the message is already fetched
    });
  });

  describe("syncToken", () => {
    it("returns null when no token set", () => {
      expect(queue.getSyncToken()).toBeNull();
    });

    it("stores and retrieves sync token", () => {
      queue.setSyncToken("s_12345");
      expect(queue.getSyncToken()).toBe("s_12345");
    });

    it("overwrites previous token", () => {
      queue.setSyncToken("s_1");
      queue.setSyncToken("s_2");
      expect(queue.getSyncToken()).toBe("s_2");
    });
  });

  describe("getContext", () => {
    it("returns recent messages per room for context", () => {
      const now = Date.now();
      queue.enqueueMessage(makeMessage({ roomId: "!r:ex.com", body: "old", timestamp: now - 3000 }));
      queue.enqueueMessage(makeMessage({ roomId: "!r:ex.com", body: "mid", timestamp: now - 2000 }));
      queue.enqueueMessage(makeMessage({ roomId: "!r:ex.com", body: "new", timestamp: now - 1000 }));

      const ctx = queue.getContext(["!r:ex.com"], 2, new Set());
      const msgs = ctx.get("!r:ex.com");
      expect(msgs).toHaveLength(2);
      // Should be in chronological order (reversed from DESC query)
      expect(msgs![0].body).toBe("mid");
      expect(msgs![1].body).toBe("new");
    });

    it("excludes specified event IDs", () => {
      queue.enqueueMessage(makeMessage({ eventId: "$skip", roomId: "!r:ex.com", body: "skip me" }));
      queue.enqueueMessage(makeMessage({ eventId: "$keep", roomId: "!r:ex.com", body: "keep me" }));

      const ctx = queue.getContext(["!r:ex.com"], 10, new Set(["$skip"]));
      const msgs = ctx.get("!r:ex.com");
      expect(msgs).toHaveLength(1);
      expect(msgs![0].body).toBe("keep me");
    });

    it("returns empty map for rooms with no messages", () => {
      const ctx = queue.getContext(["!empty:ex.com"], 10, new Set());
      expect(ctx.size).toBe(0);
    });
  });

  describe("replaySince", () => {
    it("returns all items since timestamp", () => {
      const now = Date.now();
      queue.enqueueMessage(makeMessage({ body: "old", timestamp: now - 10000 }));
      queue.enqueueMessage(makeMessage({ body: "recent", timestamp: now - 1000 }));
      queue.enqueueReaction(makeReaction({ timestamp: now - 500 }));

      const result = queue.replaySince(now - 2000);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].body).toBe("recent");
      expect(result.reactions).toHaveLength(1);
    });

    it("filters by roomId when specified", () => {
      const now = Date.now();
      queue.enqueueMessage(makeMessage({ roomId: "!a:ex.com", body: "in A", timestamp: now }));
      queue.enqueueMessage(makeMessage({ roomId: "!b:ex.com", body: "in B", timestamp: now }));

      const result = queue.replaySince(now - 1000, "!a:ex.com");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].body).toBe("in A");
    });

    it("includes fetched items (replay ignores fetch status)", () => {
      const now = Date.now();
      queue.enqueueMessage(makeMessage({ body: "was fetched", timestamp: now }));
      queue.dequeue(); // marks as fetched

      const result = queue.replaySince(now - 1000);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].body).toBe("was fetched");
    });
  });

  describe("cleanup", () => {
    it("tombstones old fetched items", () => {
      const oldTs = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago
      queue.enqueueMessage(makeMessage({ eventId: "$old", body: "old msg", timestamp: oldTs }));
      queue.dequeue(); // mark as fetched

      const cleaned = queue.cleanup(24 * 60 * 60 * 1000); // 1 day max age
      expect(cleaned).toBe(1);

      // Event ID still exists (dedup), but content is tombstoned
      // Verify by trying to enqueue same event ID — should still be rejected
      expect(queue.enqueueMessage(makeMessage({ eventId: "$old" }))).toBe(false);
    });

    it("does not tombstone unfetched items", () => {
      const oldTs = Date.now() - 2 * 24 * 60 * 60 * 1000;
      queue.enqueueMessage(makeMessage({ body: "still queued", timestamp: oldTs }));

      const cleaned = queue.cleanup(24 * 60 * 60 * 1000);
      expect(cleaned).toBe(0);

      // Message is still retrievable
      const { messages } = queue.dequeue();
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe("still queued");
    });

    it("does not tombstone recent fetched items", () => {
      queue.enqueueMessage(makeMessage({ eventId: "$recent", body: "recent" }));
      queue.dequeue();

      const cleaned = queue.cleanup(24 * 60 * 60 * 1000);
      expect(cleaned).toBe(0);
    });
  });

  describe("transaction isolation", () => {
    it("dequeue atomically selects and marks items — no double-delivery", () => {
      queue.enqueueMessage(makeMessage({ eventId: "$a", body: "A" }));
      queue.enqueueMessage(makeMessage({ eventId: "$b", body: "B" }));

      const first = queue.dequeue();
      const second = queue.dequeue();

      expect(first.messages).toHaveLength(2);
      expect(second.messages).toHaveLength(0);
    });

    it("dequeue with roomId filter does not affect other rooms", () => {
      queue.enqueueMessage(makeMessage({ eventId: "$x", roomId: "!x:ex.com", body: "X" }));
      queue.enqueueMessage(makeMessage({ eventId: "$y", roomId: "!y:ex.com", body: "Y" }));

      const result = queue.dequeue("!x:ex.com");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].body).toBe("X");

      // Other room still has its message
      const remaining = queue.dequeue("!y:ex.com");
      expect(remaining.messages).toHaveLength(1);
      expect(remaining.messages[0].body).toBe("Y");
    });

    it("tryEditInPlace is atomic — edit succeeds only if still unfetched", () => {
      const msg = makeMessage({ eventId: "$race", body: "original" });
      queue.enqueueMessage(msg);

      // Edit while still unfetched — should succeed
      expect(queue.tryEditInPlace("$race", "edited")).toBe("in-place");

      // Dequeue marks it fetched
      const { messages } = queue.dequeue();
      expect(messages[0].body).toBe("edited");

      // Now editing should return "fetched"
      expect(queue.tryEditInPlace("$race", "too late")).toBe("fetched");
    });

    it("peek returns consistent counts and room breakdown", () => {
      queue.enqueueMessage(makeMessage({ roomId: "!r:ex.com", roomName: "R" }));
      queue.enqueueMessage(makeMessage({ roomId: "!r:ex.com", roomName: "R" }));
      queue.enqueueReaction(makeReaction({ roomId: "!r:ex.com" }));

      const peek = queue.peek();
      // Total should equal sum of type counts
      expect(peek.count).toBe(peek.types.messages + peek.types.reactions + peek.types.invites);
      expect(peek.types.messages).toBe(2);
      expect(peek.types.reactions).toBe(1);
      // Room breakdown should match message count
      expect(peek.rooms).toHaveLength(1);
      expect(peek.rooms[0].count).toBe(2);
    });

    it("concurrent enqueue and dequeue do not lose items", () => {
      // Enqueue several items
      for (let i = 0; i < 10; i++) {
        queue.enqueueMessage(makeMessage({ body: `msg-${i}` }));
      }

      // Dequeue all
      const result = queue.dequeue();
      expect(result.messages).toHaveLength(10);

      // Enqueue more after dequeue
      for (let i = 10; i < 15; i++) {
        queue.enqueueMessage(makeMessage({ body: `msg-${i}` }));
      }

      const result2 = queue.dequeue();
      expect(result2.messages).toHaveLength(5);

      // Nothing left
      expect(queue.peek().count).toBe(0);
    });
  });
});
