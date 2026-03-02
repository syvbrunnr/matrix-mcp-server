import { z } from "zod";
import { EventType } from "matrix-js-sdk";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Rel types to try, in preference order (Dendrite uses io.element.thread)
const THREAD_REL_TYPES = ["io.element.thread", "m.thread"];

export const registerThreadMessageTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "get-thread-messages",
    {
      title: "Get Thread Messages",
      description:
        "Retrieve all messages in a specific thread. " +
        "Use the threadRootEventId from a previous get-room-messages or wait-for-messages call. " +
        "Returns the thread root event plus all replies, ordered oldest first.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        threadRootEventId: z
          .string()
          .describe("Event ID of the thread root message"),
        limit: z
          .number()
          .default(50)
          .describe("Maximum number of thread replies to return (default: 50)"),
      },
    },
    async (
      { roomId, threadRootEventId, limit }: { roomId: string; threadRootEventId: string; limit: number },
      { requestInfo, authInfo }: any
    ) => {
      const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
      const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

      try {
        const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

        // Try each thread rel type until we find replies
        let allEvents: any[] = [];
        let originalEvent: any = null;

        for (const relType of THREAD_REL_TYPES) {
          try {
            const result = await client.relations(
              roomId,
              threadRootEventId,
              relType,
              EventType.RoomMessage,
              { limit, dir: "b" as any }
            );
            if (result.originalEvent) originalEvent = result.originalEvent;
            if (result.events.length > 0) {
              allEvents = result.events;
              break;
            }
          } catch (e) {
            // Try next rel type
          }
        }

        // If relations API gave nothing, fall back to scanning main timeline
        if (allEvents.length === 0) {
          const room = client.getRoom(roomId);
          if (room) {
            const timelineEvents = room.getLiveTimeline().getEvents();
            allEvents = timelineEvents.filter((event) => {
              if (event.getType() !== EventType.RoomMessage) return false;
              const relatesTo = event.getContent()?.["m.relates_to"];
              return (
                (relatesTo?.rel_type === "io.element.thread" || relatesTo?.rel_type === "m.thread") &&
                relatesTo?.event_id === threadRootEventId
              );
            });
          }
        }

        // Sort oldest first (relations API returns newest first)
        allEvents = allEvents
          .filter((e) => {
            const relatesTo = e.getContent()?.["m.relates_to"];
            return relatesTo?.rel_type !== "m.replace" && !e.isRedacted();
          })
          .sort((a: any, b: any) => a.getTs() - b.getTs())
          .slice(0, limit);

        // Format root event if available
        const messages: string[] = [];

        if (originalEvent) {
          const rootContent = originalEvent.getContent();
          if (rootContent?.msgtype === "m.text") {
            messages.push(JSON.stringify({
              eventId: originalEvent.getId(),
              sender: originalEvent.getSender(),
              timestamp: new Date(originalEvent.getTs()).toISOString(),
              body: String(rootContent.body || ""),
              isThreadRoot: true,
            }));
          }
        }

        for (const event of allEvents) {
          const content = event.getContent();
          if (content?.msgtype !== "m.text") continue;
          const relatesTo = content["m.relates_to"];
          messages.push(JSON.stringify({
            eventId: event.getId(),
            sender: event.getSender(),
            timestamp: new Date(event.getTs()).toISOString(),
            body: String(content.body || ""),
            threadRootEventId,
            ...(relatesTo?.["m.in_reply_to"]?.event_id
              ? { replyToEventId: relatesTo["m.in_reply_to"].event_id }
              : {}),
          }));
        }

        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No messages found in thread ${threadRootEventId}` }],
          };
        }

        return {
          content: messages.map((m) => ({ type: "text" as const, text: m })),
        };
      } catch (error: any) {
        console.error(`Failed to get thread messages: ${error.message}`);
        removeClientFromCache(matrixUserId, homeserverUrl);
        return {
          content: [{ type: "text" as const, text: `Error: Failed to get thread messages - ${error.message}` }],
          isError: true,
        };
      }
    }
  );
};
