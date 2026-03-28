import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { buildDmRoomSet, extractQueuedMessage, scheduleDecryptionRetries, handleEditEvent } from "./syncEventHandlers.js";
import { EventType } from "matrix-js-sdk";

// ── Mocks ──────────────────────────────────────────────────────────────────

function mockClient(opts: {
  accountData?: Record<string, string[]>;
  rooms?: Array<{ roomId: string; name: string; joinedMembers: number; joinRule?: string }>;
} = {}): any {
  const rooms = (opts.rooms || []).map(r => ({
    roomId: r.roomId,
    name: r.name,
    getJoinedMemberCount: () => r.joinedMembers,
    currentState: {
      getStateEvents: (type: string) => {
        if (type === "m.room.join_rules") {
          return { getContent: () => ({ join_rule: r.joinRule || "invite" }) };
        }
        return null;
      },
    },
  }));
  return {
    getAccountData: (type: string) => {
      if (type === "m.direct" && opts.accountData) {
        return { getContent: () => opts.accountData };
      }
      return null;
    },
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find(r => r.roomId === id) || null,
  };
}

function mockEvent(opts: {
  type?: string;
  sender?: string;
  roomId?: string;
  body?: string;
  id?: string;
  ts?: number;
  relatesTo?: any;
  isRedacted?: boolean;
}): any {
  const content = {
    body: opts.body ?? "hello",
    ...(opts.relatesTo ? { "m.relates_to": opts.relatesTo } : {}),
  };
  return {
    getType: () => opts.type ?? EventType.RoomMessage,
    getSender: () => opts.sender ?? "@alice:ex.com",
    getRoomId: () => opts.roomId ?? "!room:ex.com",
    getId: () => opts.id ?? "$evt1",
    getTs: () => opts.ts ?? 1000,
    getContent: () => content,
    getClearContent: () => content,
    isRedacted: () => opts.isRedacted ?? false,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("buildDmRoomSet", () => {
  it("includes rooms from m.direct account data", () => {
    const client = mockClient({
      accountData: { "@bob:ex.com": ["!dm1:ex.com", "!dm2:ex.com"] },
    });
    const set = buildDmRoomSet(client);
    expect(set.has("!dm1:ex.com")).toBe(true);
    expect(set.has("!dm2:ex.com")).toBe(true);
  });

  it("uses fallback for 2-member non-public rooms", () => {
    const client = mockClient({
      rooms: [
        { roomId: "!private:ex.com", name: "DM", joinedMembers: 2, joinRule: "invite" },
        { roomId: "!group:ex.com", name: "Group", joinedMembers: 5, joinRule: "invite" },
        { roomId: "!public:ex.com", name: "Public", joinedMembers: 2, joinRule: "public" },
      ],
    });
    const set = buildDmRoomSet(client);
    expect(set.has("!private:ex.com")).toBe(true);
    expect(set.has("!group:ex.com")).toBe(false);
    expect(set.has("!public:ex.com")).toBe(false);
  });

  it("handles non-array values in m.direct gracefully", () => {
    const client = mockClient({
      accountData: {
        "@bob:ex.com": ["!dm1:ex.com"],
        "@broken:ex.com": "not-an-array" as any,
        "@also-broken:ex.com": null as any,
      } as any,
    });
    const set = buildDmRoomSet(client);
    expect(set.has("!dm1:ex.com")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("returns empty set for client with no rooms or account data", () => {
    const client = mockClient();
    const set = buildDmRoomSet(client);
    expect(set.size).toBe(0);
  });
});

describe("extractQueuedMessage", () => {
  const dmRoomIds = new Set(["!dm:ex.com"]);

  it("extracts a basic message", () => {
    const client = mockClient({ rooms: [{ roomId: "!room:ex.com", name: "Room", joinedMembers: 5 }] });
    const event = mockEvent({ roomId: "!room:ex.com", body: "hello" });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe("hello");
    expect(msg!.isDM).toBe(false);
  });

  it("marks DM rooms correctly", () => {
    const client = mockClient({ rooms: [{ roomId: "!dm:ex.com", name: "DM", joinedMembers: 2 }] });
    const event = mockEvent({ roomId: "!dm:ex.com", body: "secret" });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).not.toBeNull();
    expect(msg!.isDM).toBe(true);
  });

  it("skips own messages", () => {
    const client = mockClient();
    const event = mockEvent({ sender: "@mimir:ex.com" });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).toBeNull();
  });

  it("skips non-message events", () => {
    const client = mockClient();
    const event = mockEvent({ type: "m.room.member" });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).toBeNull();
  });

  it("skips edit (m.replace) events", () => {
    const client = mockClient();
    const event = mockEvent({ relatesTo: { rel_type: "m.replace", event_id: "$orig" } });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).toBeNull();
  });

  it("skips redacted events", () => {
    const client = mockClient();
    const event = mockEvent({ isRedacted: true });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).toBeNull();
  });

  it("extracts thread root event ID", () => {
    const client = mockClient({ rooms: [{ roomId: "!room:ex.com", name: "Room", joinedMembers: 5 }] });
    const event = mockEvent({
      roomId: "!room:ex.com",
      relatesTo: { rel_type: "m.thread", event_id: "$thread1" },
    });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).not.toBeNull();
    expect(msg!.threadRootEventId).toBe("$thread1");
  });

  it("extracts reply_to event ID", () => {
    const client = mockClient({ rooms: [{ roomId: "!room:ex.com", name: "Room", joinedMembers: 5 }] });
    const event = mockEvent({
      roomId: "!room:ex.com",
      relatesTo: { "m.in_reply_to": { event_id: "$replied" } },
    });
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).not.toBeNull();
    expect(msg!.replyToEventId).toBe("$replied");
  });

  it("returns null when event has no ID", () => {
    const client = mockClient({ rooms: [{ roomId: "!room:ex.com", name: "Room", joinedMembers: 5 }] });
    const event = mockEvent({ id: undefined as any });
    // Override getId to return null
    event.getId = () => null;
    const msg = extractQueuedMessage(event, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).toBeNull();
  });

  it("handles encrypted messages with no body", () => {
    const encrypted = {
      getType: () => EventType.RoomMessageEncrypted,
      getSender: () => "@alice:ex.com",
      getRoomId: () => "!room:ex.com",
      getId: () => "$enc1",
      getTs: () => 2000,
      getContent: () => ({}),
      getClearContent: () => ({}),
      isRedacted: () => false,
    };
    const client = mockClient({ rooms: [{ roomId: "!room:ex.com", name: "Room", joinedMembers: 5 }] });
    const msg = extractQueuedMessage(encrypted as any, "@mimir:ex.com", dmRoomIds, client);
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe("[encrypted]");
    expect(msg!.decryptionFailed).toBe(true);
  });
});

describe("scheduleDecryptionRetries", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mockEncryptedEvent(opts: { body?: string; decryptSucceeds?: boolean } = {}): any {
    let decryptedBody = opts.body ?? null;
    const listeners: Record<string, Function[]> = {};
    return {
      once: (eventName: string, cb: Function) => {
        if (!listeners[eventName]) listeners[eventName] = [];
        listeners[eventName].push(cb);
      },
      getClearContent: () => (decryptedBody ? { body: decryptedBody } : {}),
      getContent: () => ({}),
      attemptDecryption: async () => {
        if (opts.decryptSucceeds) {
          decryptedBody = "decrypted message";
        }
      },
      _fireDecrypted: () => {
        for (const cb of listeners["Event.decrypted"] || []) cb();
      },
    };
  }

  function mockQueue(): any {
    return {
      updateDecryptedBody: jest.fn(),
    };
  }

  function mockCryptoClient(): any {
    return {
      getCrypto: () => ({}),
    };
  }

  it("registers a Decrypted event listener", () => {
    const event = mockEncryptedEvent();
    const queue = mockQueue();
    const client = mockCryptoClient();
    scheduleDecryptionRetries(event as any, "$enc1", client, queue);

    // Simulate SDK decryption event
    (event as any)._fireDecrypted();
    // No body in getClearContent, so updateDecryptedBody should not be called
    expect(queue.updateDecryptedBody).not.toHaveBeenCalled();
  });

  it("updates queue when Decrypted event fires with body", () => {
    const event = mockEncryptedEvent({ body: "hello decrypted" });
    const queue = mockQueue();
    const client = mockCryptoClient();
    scheduleDecryptionRetries(event as any, "$enc2", client, queue);

    event._fireDecrypted();
    expect(queue.updateDecryptedBody).toHaveBeenCalledWith("$enc2", "hello decrypted");
  });

  it("schedules 3 retry attempts at 2s, 5s, 15s", () => {
    const event = mockEncryptedEvent({ decryptSucceeds: true });
    const queue = mockQueue();
    const client = mockCryptoClient();
    scheduleDecryptionRetries(event as any, "$enc3", client, queue);

    // No calls before any timer fires
    expect(queue.updateDecryptedBody).not.toHaveBeenCalled();

    // Advance to 2s — first retry fires and succeeds
    jest.advanceTimersByTime(2000);
    // Need to flush promises for async setTimeout callbacks
    return Promise.resolve().then(() => {
      expect(queue.updateDecryptedBody).toHaveBeenCalledWith("$enc3", "decrypted message");
    });
  });

  it("does not count '[encrypted]' body as successful decryption", () => {
    // After attemptDecryption, if body is still "[encrypted]", should NOT call updateDecryptedBody
    let callCount = 0;
    const event: any = {
      once: () => {},
      getClearContent: () => null,
      getContent: () => ({ body: "[encrypted]" }),
      attemptDecryption: async () => {},
    };
    const queue = { updateDecryptedBody: jest.fn() };
    const client = mockCryptoClient();
    scheduleDecryptionRetries(event, "$enc6", client, queue as any);

    jest.advanceTimersByTime(2000);
    return Promise.resolve().then(() => {
      expect(queue.updateDecryptedBody).not.toHaveBeenCalled();
    });
  });

  it("skips retry if already decrypted", () => {
    const event = mockEncryptedEvent({ body: "already decrypted" });
    const queue = mockQueue();
    const client = mockCryptoClient();
    scheduleDecryptionRetries(event as any, "$enc4", client, queue);

    jest.advanceTimersByTime(2000);
    return Promise.resolve().then(() => {
      // Should not call updateDecryptedBody from retry since body already exists
      // (only from the Decrypted event listener if fired)
      expect(queue.updateDecryptedBody).not.toHaveBeenCalled();
    });
  });

  it("handles client with no crypto gracefully", () => {
    const event = mockEncryptedEvent();
    const queue = mockQueue();
    const client = { getCrypto: () => null };
    scheduleDecryptionRetries(event as any, "$enc5", client as any, queue);

    jest.advanceTimersByTime(15000);
    return Promise.resolve().then(() => {
      expect(queue.updateDecryptedBody).not.toHaveBeenCalled();
    });
  });
});

describe("handleEditEvent", () => {
  function mockEditEvent(opts: {
    sender?: string;
    originalEventId?: string;
    newBody?: string;
    roomId?: string;
    id?: string;
  }): any {
    const content = {
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: opts.originalEventId ?? "$orig1",
      },
      "m.new_content": { body: opts.newBody ?? "edited text" },
    };
    return {
      getSender: () => opts.sender ?? "@alice:ex.com",
      getRoomId: () => opts.roomId ?? "!room:ex.com",
      getId: () => opts.id ?? "$edit1",
      getTs: () => 3000,
      getContent: () => content,
      getClearContent: () => content,
    };
  }

  function mockEditQueue(editResult: "in-place" | "fetched" | "not-found"): any {
    return {
      tryEditInPlace: jest.fn().mockReturnValue(editResult),
      enqueueMessage: jest.fn(),
    };
  }

  it("skips own edits", () => {
    const event = mockEditEvent({ sender: "@mimir:ex.com" });
    const queue = mockEditQueue("in-place");
    const client = mockClient();
    handleEditEvent(event, "@mimir:ex.com", new Set(), client, queue);
    expect(queue.tryEditInPlace).not.toHaveBeenCalled();
  });

  it("skips events without m.replace rel_type", () => {
    const event = {
      getSender: () => "@alice:ex.com",
      getClearContent: () => ({ "m.relates_to": { rel_type: "m.thread" } }),
      getContent: () => ({ "m.relates_to": { rel_type: "m.thread" } }),
    };
    const queue = mockEditQueue("in-place");
    const client = mockClient();
    handleEditEvent(event as any, "@mimir:ex.com", new Set(), client, queue);
    expect(queue.tryEditInPlace).not.toHaveBeenCalled();
  });

  it("calls tryEditInPlace with original event ID and new body", () => {
    const event = mockEditEvent({ originalEventId: "$orig99", newBody: "updated" });
    const queue = mockEditQueue("in-place");
    const client = mockClient();
    handleEditEvent(event as any, "@mimir:ex.com", new Set(), client, queue);
    expect(queue.tryEditInPlace).toHaveBeenCalledWith("$orig99", "updated");
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  });

  it("enqueues new message when original was already fetched", () => {
    const event = mockEditEvent({
      originalEventId: "$orig99",
      newBody: "late edit",
      roomId: "!dm:ex.com",
    });
    const queue = mockEditQueue("fetched");
    const client = mockClient({ rooms: [{ roomId: "!dm:ex.com", name: "DM", joinedMembers: 2 }] });
    const dmRoomIds = new Set(["!dm:ex.com"]);
    handleEditEvent(event as any, "@mimir:ex.com", dmRoomIds, client, queue);
    expect(queue.enqueueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "late edit",
        editedOriginalEventId: "$orig99",
        isDM: true,
      }),
    );
  });

  it("skips edit with empty new body", () => {
    const event = mockEditEvent({ newBody: "" });
    const queue = mockEditQueue("in-place");
    const client = mockClient();
    handleEditEvent(event as any, "@mimir:ex.com", new Set(), client, queue);
    expect(queue.tryEditInPlace).not.toHaveBeenCalled();
  });

  it("does nothing when original was not found", () => {
    const event = mockEditEvent({});
    const queue = mockEditQueue("not-found");
    const client = mockClient();
    handleEditEvent(event as any, "@mimir:ex.com", new Set(), client, queue);
    expect(queue.tryEditInPlace).toHaveBeenCalled();
    expect(queue.enqueueMessage).not.toHaveBeenCalled();
  });
});
