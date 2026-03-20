import { z } from "zod";
import { MatrixEvent } from "matrix-js-sdk";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache, getDiagnosticHint } from "../../utils/matrix-errors.js";
import { processMessage } from "../../matrix/messageProcessor.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

interface ContextResponse {
  event: any;
  events_before: any[];
  events_after: any[];
  start?: string;
  end?: string;
}

export const getEventContextHandler = async (
  { roomId, eventId, limit }: { roomId: string; eventId: string; limit: number },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const response = await client.http.authedRequest<ContextResponse>(
      Method.Get,
      `/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(eventId)}`,
      { limit: String(limit) },
    );

    const allRawEvents = [
      ...(response.events_before || []).reverse(),
      response.event,
      ...(response.events_after || []),
    ];

    const messages = await Promise.all(
      allRawEvents.map((raw: any) => processMessage(new MatrixEvent(raw), client))
    );
    const validMessages = messages.filter((m) => m !== null);

    if (validMessages.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No messages found around event ${eventId}` }],
      };
    }

    // Mark which message is the target event
    const result: any[] = validMessages.map((m) => {
      if (m.type === "text") {
        try {
          const parsed = JSON.parse(m.text);
          if (parsed.eventId === eventId) {
            parsed.isTargetEvent = true;
            return { type: "text" as const, text: JSON.stringify(parsed) };
          }
        } catch {
          // Not JSON, return as-is
        }
      }
      return m;
    });

    return { content: result };
  } catch (error: any) {
    console.error(`Failed to get event context: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);

    const isNotFound = error.message?.includes("M_NOT_FOUND") || error.httpStatus === 404;
    const errorMsg = isNotFound
      ? `Error: Event ${eventId} not found in room ${roomId}. The event may have been redacted or you may not have access.`
      : `Error: Failed to get event context - ${error.message}\n${getDiagnosticHint(error)}`;

    return {
      content: [{ type: "text" as const, text: errorMsg }],
      isError: true,
    };
  }
};

export const registerEventContextTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "get-event-context",
    {
      title: "Get Event Context",
      description:
        "Retrieve messages surrounding a specific event in a Matrix room. " +
        "Returns messages before and after the target event, with the target marked " +
        "with isTargetEvent: true. Useful for understanding conversation context around " +
        "a specific message found via search, notification, or thread reference.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        eventId: z.string().describe("Event ID to get context for (e.g., $eventid)"),
        limit: z.coerce
          .number()
          .default(10)
          .describe("Number of messages to return before and after the event (default: 10)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getEventContextHandler
  );
};
