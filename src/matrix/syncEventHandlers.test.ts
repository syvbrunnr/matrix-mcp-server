import { describe, it, expect } from "@jest/globals";
import { buildDmRoomSet, extractQueuedMessage } from "./syncEventHandlers.js";
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
