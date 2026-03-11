import { z } from "zod";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

export const registerGetQueuedMessagesTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "get-queued-messages",
    {
      title: "Get Queued Matrix Messages",
      description:
        "Retrieve queued messages, reactions, and invites. Non-blocking — returns whatever is currently queued. " +
        "Messages are marked as fetched after retrieval (won't be returned again). " +
        "Optionally filter by room ID.",
      inputSchema: {
        roomId: z
          .string()
          .optional()
          .describe("Optional room ID to fetch messages for a specific room only"),
        contextMessages: z
          .number()
          .optional()
          .describe("Include N recent previous messages per room/DM for conversation context (default: 3, max: 10)"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ roomId, contextMessages }: { roomId?: string; contextMessages?: number }) => {
      const queue = getMessageQueue();
      const contents = queue.dequeue(roomId);

      // Build context if requested
      const ctxLimit = Math.min(Math.max(contextMessages ?? 3, 0), 10);
      let context: Record<string, any[]> | undefined;
      if (ctxLimit > 0 && contents.messages.length > 0) {
        const roomIds = [...new Set(contents.messages.map(m => m.roomId))];
        const excludeIds = new Set(contents.messages.map(m => m.eventId));
        const ctxMap = queue.getContext(roomIds, ctxLimit, excludeIds);
        if (ctxMap.size > 0) {
          context = {};
          for (const [rid, msgs] of ctxMap) {
            const roomName = contents.messages.find(m => m.roomId === rid)?.roomName ?? rid;
            context[roomName] = msgs.map(m => ({
              sender: m.sender,
              body: m.body,
              timestamp: new Date(m.timestamp).toISOString(),
              ...(m.threadRootEventId ? { threadRootEventId: m.threadRootEventId } : {}),
            }));
          }
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
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
              ...(m.editedOriginalEventId ? { editedOriginalEventId: m.editedOriginalEventId } : {}),
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
            ...(context ? { context } : {}),
          }),
        }],
      };
    }
  );
};
