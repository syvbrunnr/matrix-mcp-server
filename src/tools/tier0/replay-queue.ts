import { z } from "zod";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

export const replayQueueHandler = async (
  { sinceTimestamp, roomId }: { sinceTimestamp: string; roomId?: string }
) => {
  const sinceMs = new Date(sinceTimestamp).getTime();
  if (isNaN(sinceMs)) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ error: "Invalid timestamp. Use ISO 8601 format (e.g., '2026-03-07T10:00:00Z')." }),
      }],
      isError: true,
    };
  }

  const queue = getMessageQueue();
  const contents = queue.replaySince(sinceMs, roomId);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        replayedSince: sinceTimestamp,
        messageCount: contents.messages.length,
        reactionCount: contents.reactions.length,
        inviteCount: contents.invites.length,
        messages: contents.messages.map(m => ({
          eventId: m.eventId,
          room: m.roomName,
          roomId: m.roomId,
          sender: m.sender,
          body: m.body,
          timestamp: new Date(m.timestamp).toISOString(),
          isDM: m.isDM,
          ...(m.threadRootEventId ? { threadRootEventId: m.threadRootEventId } : {}),
          ...(m.replyToEventId ? { replyToEventId: m.replyToEventId } : {}),
          ...(m.decryptionFailed ? { decryptionFailed: true } : {}),
          ...(m.decryptionFailureReason ? { decryptionFailureReason: m.decryptionFailureReason } : {}),
        })),
        reactions: contents.reactions.map(r => ({
          eventId: r.eventId,
          room: r.roomName,
          roomId: r.roomId,
          sender: r.sender,
          emoji: r.emoji,
          reactedToEventId: r.reactedToEventId,
          timestamp: new Date(r.timestamp).toISOString(),
        })),
        invites: contents.invites.map(i => ({
          roomId: i.roomId,
          roomName: i.roomName,
          invitedBy: i.invitedBy,
          timestamp: new Date(i.timestamp).toISOString(),
        })),
      }),
    }],
  };
};

export const registerReplayQueueTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "replay-queue",
    {
      title: "Replay Message Queue",
      description:
        "Retrieve messages from the queue since a given timestamp, including already-fetched messages. " +
        "Read-only — does NOT mark messages as fetched. " +
        "Use to recover missed messages when get-queued-messages was called prematurely or by a misbehaving agent. " +
        "Replay window bounded by 24h retention (fetched items older than 24h are cleaned up).",
      inputSchema: {
        sinceTimestamp: z
          .string()
          .describe("ISO 8601 timestamp to replay from (e.g., '2026-03-07T10:00:00Z')"),
        roomId: z
          .string()
          .optional()
          .describe("Optional room ID to filter replay to a specific room"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    replayQueueHandler
  );
};
