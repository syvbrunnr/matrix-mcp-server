import { buildRelatesTo, resolveThreadRoot } from "./threading.js";

describe("buildRelatesTo", () => {
  it("returns undefined when no thread root or reply", () => {
    expect(buildRelatesTo(undefined, undefined)).toBeUndefined();
  });

  it("builds inline reply when only replyToEventId provided", () => {
    const result = buildRelatesTo(undefined, "$reply123");
    expect(result).toEqual({
      "m.in_reply_to": { event_id: "$reply123" },
    });
  });

  it("builds thread with fallback when only threadRoot provided", () => {
    const result = buildRelatesTo("$thread_root", undefined);
    expect(result).toEqual({
      rel_type: "io.element.thread",
      event_id: "$thread_root",
      "m.in_reply_to": { event_id: "$thread_root" },
      is_falling_back: true,
    });
  });

  it("builds thread with reply when both provided", () => {
    const result = buildRelatesTo("$thread_root", "$reply123");
    expect(result).toEqual({
      rel_type: "io.element.thread",
      event_id: "$thread_root",
      "m.in_reply_to": { event_id: "$reply123" },
      is_falling_back: false,
    });
  });

  it("uses io.element.thread rel_type for Dendrite/Element compatibility", () => {
    const result = buildRelatesTo("$thread_root");
    expect(result?.rel_type).toBe("io.element.thread");
  });
});

describe("resolveThreadRoot", () => {
  // Helper to create a minimal mock Room
  function mockRoom(opts: {
    joinedMemberCount?: number;
    events?: Record<string, { content: Record<string, any> }>;
  }) {
    const events = opts.events || {};
    return {
      findEventById: (id: string) => {
        const evt = events[id];
        if (!evt) return undefined;
        return { getContent: () => evt.content };
      },
      getJoinedMemberCount: () => opts.joinedMemberCount ?? 3,
    } as any;
  }

  it("returns threadRootEventId when explicitly provided", () => {
    const room = mockRoom({});
    expect(resolveThreadRoot(room, "$reply", "$explicit_root")).toBe("$explicit_root");
  });

  it("returns undefined when no replyToEventId", () => {
    const room = mockRoom({});
    expect(resolveThreadRoot(room, undefined, undefined)).toBeUndefined();
  });

  it("stays in existing thread when replying to a threaded message", () => {
    const room = mockRoom({
      events: {
        "$threaded_msg": {
          content: {
            "m.relates_to": { rel_type: "m.thread", event_id: "$original_root" },
          },
        },
      },
    });
    expect(resolveThreadRoot(room, "$threaded_msg")).toBe("$original_root");
  });

  it("stays in existing thread with io.element.thread rel_type", () => {
    const room = mockRoom({
      events: {
        "$threaded_msg": {
          content: {
            "m.relates_to": { rel_type: "io.element.thread", event_id: "$original_root" },
          },
        },
      },
    });
    expect(resolveThreadRoot(room, "$threaded_msg")).toBe("$original_root");
  });

  it("auto-starts thread in group rooms (3+ members)", () => {
    const room = mockRoom({
      joinedMemberCount: 5,
      events: {
        "$standalone_msg": { content: { body: "hello" } },
      },
    });
    expect(resolveThreadRoot(room, "$standalone_msg")).toBe("$standalone_msg");
  });

  it("does not auto-thread in DMs (2 members)", () => {
    const room = mockRoom({
      joinedMemberCount: 2,
      events: {
        "$standalone_msg": { content: { body: "hello" } },
      },
    });
    expect(resolveThreadRoot(room, "$standalone_msg")).toBeUndefined();
  });

  it("auto-threads in group room even when event not found locally", () => {
    const room = mockRoom({ joinedMemberCount: 4 });
    expect(resolveThreadRoot(room, "$unknown_event")).toBe("$unknown_event");
  });

  it("does not auto-thread in DM even when event not found locally", () => {
    const room = mockRoom({ joinedMemberCount: 2 });
    expect(resolveThreadRoot(room, "$unknown_event")).toBeUndefined();
  });
});
