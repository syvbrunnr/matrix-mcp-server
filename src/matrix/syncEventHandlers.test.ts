import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { buildDmRoomSet, extractQueuedMessage, scheduleDecryptionRetries } from "./syncEventHandlers.js";
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
