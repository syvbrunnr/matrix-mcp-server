import { Room } from "matrix-js-sdk";

/**
 * Resolve the effective thread root for a message, applying auto-threading rules.
 *
 * Rules:
 * - If threadRootEventId is explicitly provided, use it.
 * - If replying to a message that's already in a thread, stay in that thread.
 * - In group rooms (3+ members), replying to a standalone message auto-starts a new thread.
 * - In DMs (2 members), replies are inline (no auto-threading).
 */
export function resolveThreadRoot(
  room: Room,
  replyToEventId?: string,
  threadRootEventId?: string
): string | undefined {
  if (threadRootEventId) return threadRootEventId;
  if (!replyToEventId) return undefined;

  const targetEvent = room.findEventById(replyToEventId);
  if (targetEvent) {
    const targetRelatesTo = targetEvent.getContent()?.["m.relates_to"];
    if (
      targetRelatesTo?.rel_type === "m.thread" ||
      targetRelatesTo?.rel_type === "io.element.thread"
    ) {
      return targetRelatesTo.event_id;
    }
    if (room.getJoinedMemberCount() > 2) {
      return replyToEventId;
    }
  } else if (room.getJoinedMemberCount() > 2) {
    return replyToEventId;
  }

  return undefined;
}

/**
 * Build the m.relates_to object for threading and/or replies.
 * Uses io.element.thread for broad compatibility (Element/Dendrite).
 */
export function buildRelatesTo(
  effectiveThreadRoot?: string,
  replyToEventId?: string
): Record<string, any> | undefined {
  if (effectiveThreadRoot) {
    return {
      rel_type: "io.element.thread",
      event_id: effectiveThreadRoot,
      "m.in_reply_to": {
        event_id: replyToEventId || effectiveThreadRoot,
      },
      is_falling_back: !replyToEventId,
    };
  }

  if (replyToEventId) {
    return {
      "m.in_reply_to": {
        event_id: replyToEventId,
      },
    };
  }

  return undefined;
}
