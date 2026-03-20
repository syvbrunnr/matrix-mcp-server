import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MatrixEvent } from "matrix-js-sdk";
import { Direction } from "matrix-js-sdk/lib/models/event-timeline.js";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache, getDiagnosticHint } from "../../utils/matrix-errors.js";
import { processMessage, processMessagesByDate, countMessagesByUser } from "../../matrix/messageProcessor.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { sendReadReceipt } from "../../utils/read-receipt.js";

// Tool: Get room messages
export const getRoomMessagesHandler = async (
  { roomId, limit, paginationToken }: { roomId: string; limit: number; paginationToken?: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Room with ID ${roomId} not found. You may not be a member of this room.`,
          },
        ],
        isError: true,
      };
    }

    // Paginated mode: fetch from server-side /messages API
    if (paginationToken) {
      const response = await client.createMessagesRequest(
        roomId, paginationToken, limit, Direction.Backward,
      );

      const events = (response.chunk || []).map((raw: any) => new MatrixEvent(raw));
      const messages = await Promise.all(
        events.map((event: MatrixEvent) => processMessage(event, client))
      );
      const validMessages = messages.filter((m) => m !== null);

      const result: any[] = validMessages.length > 0
        ? validMessages
        : [{ type: "text" as const, text: `No messages found in room ${room.name || roomId}` }];

      if (response.end) {
        result.push({ type: "text" as const, text: `__nextPageToken:${response.end}` });
      }

      return { content: result };
    }

    // Default mode: synced timeline
    const messages = await Promise.all(
      room
        .getLiveTimeline()
        .getEvents()
        .slice(-limit)
        .map((event) => processMessage(event, client))
    );

    const validMessages = messages.filter((message) => message !== null);

    sendReadReceipt(client, room);

    const result: any[] = validMessages.length > 0
      ? validMessages
      : [{ type: "text" as const, text: `No messages found in room ${room.name || roomId}` }];

    // Include pagination token for fetching older messages
    const backwardToken = room.getLiveTimeline().getPaginationToken(Direction.Backward);
    if (backwardToken) {
      result.push({ type: "text" as const, text: `__nextPageToken:${backwardToken}` });
    }

    return { content: result };
  } catch (error: any) {
    console.error(`Failed to get room messages: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to get room messages - ${error.message}\n${getDiagnosticHint(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Get messages by date
export const getMessagesByDateHandler = async (
  { roomId, startDate, endDate, limit, paginationToken }: {
    roomId: string; startDate: string; endDate: string; limit: number; paginationToken?: string;
  },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Room with ID ${roomId} not found. You may not be a member of this room.`,
          },
        ],
        isError: true,
      };
    }

    // Paginated mode: fetch from server-side /messages API with date filtering
    if (paginationToken) {
      // Fetch more than limit to account for date filtering
      const fetchSize = Math.min(limit * 3, 100);
      const response = await client.createMessagesRequest(
        roomId, paginationToken, fetchSize, Direction.Backward,
      );

      const rawEvents = (response.chunk || []).map((raw: any) => new MatrixEvent(raw));
      const inRange = rawEvents.filter((e: MatrixEvent) => {
        const ts = e.getTs();
        return ts >= startMs && ts <= endMs;
      });

      const messages = await Promise.all(
        inRange.slice(0, limit).map((event: MatrixEvent) => processMessage(event, client))
      );
      const validMessages = messages.filter((m) => m !== null);

      const result: any[] = validMessages.length > 0
        ? validMessages
        : [{ type: "text" as const, text: `No messages found in room ${room.name || roomId} between ${startDate} and ${endDate}` }];

      // Include nextPageToken only if we haven't passed the start date boundary
      const oldestFetched = rawEvents.length > 0
        ? Math.min(...rawEvents.map((e: MatrixEvent) => e.getTs()))
        : 0;
      if (response.end && oldestFetched >= startMs) {
        result.push({ type: "text" as const, text: `__nextPageToken:${response.end}` });
      }

      return { content: result };
    }

    // Default mode: synced timeline filtered by date
    const events = room.getLiveTimeline().getEvents();
    const messages = await processMessagesByDate(events, startDate, endDate, client);

    sendReadReceipt(client, room);

    const result: any[] = messages.length > 0
      ? messages
      : [{ type: "text" as const, text: `No messages found in room ${room.name || roomId} between ${startDate} and ${endDate}` }];

    // Include pagination token for fetching older date-filtered messages
    const backwardToken = room.getLiveTimeline().getPaginationToken(Direction.Backward);
    if (backwardToken) {
      result.push({ type: "text" as const, text: `__nextPageToken:${backwardToken}` });
    }

    return { content: result };
  } catch (error: any) {
    console.error(`Failed to filter messages by date: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to filter messages by date - ${error.message}\n${getDiagnosticHint(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Identify active users
export const identifyActiveUsersHandler = async (
  { roomId, limit }: { roomId: string; limit: number },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Room with ID ${roomId} not found. You may not be a member of this room.`,
          },
        ],
        isError: true,
      };
    }

    const events = room.getLiveTimeline().getEvents();
    const activeUsers = countMessagesByUser(events, limit);

    return {
      content:
        activeUsers.length > 0
          ? activeUsers.map((user) => ({
              type: "text",
              text: `${user.userId}: ${user.count} messages`,
            }))
          : [
              {
                type: "text",
                text: `No message activity found in room ${room.name || roomId}`,
              },
            ],
    };
  } catch (error: any) {
    console.error(`Failed to identify active users: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to identify active users - ${error.message}\n${getDiagnosticHint(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// Registration function
export const registerMessageTools: ToolRegistrationFunction = (server) => {
  // Tool: Get room messages
  server.registerTool(
    "get-room-messages",
    {
      title: "Get Matrix Room Messages",
      description:
        "Retrieve messages from a Matrix room. Without paginationToken, returns recent messages " +
        "from the synced timeline. With paginationToken, fetches older messages from the server " +
        "using the Matrix /messages API (supports full room history, not just synced events). " +
        "Each text message is a JSON object with: eventId, sender, timestamp, body, " +
        "and optionally replyToEventId and threadRootEventId. " +
        "Response includes a __nextPageToken entry when more messages are available — " +
        "pass its value as paginationToken to fetch the next page.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        limit: z.coerce
          .number()
          .default(20)
          .describe("Maximum number of messages to retrieve (default: 20)"),
        paginationToken: z
          .string()
          .optional()
          .describe(
            "Token for fetching older messages. Omit for recent synced messages. " +
            "Use the __nextPageToken value from a previous response to page backward through history."
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getRoomMessagesHandler
  );

  // Tool: Get messages by date
  server.registerTool(
    "get-messages-by-date",
    {
      title: "Get Matrix Messages by Date Range",
      description:
        "Retrieve messages from a Matrix room within a specific date range. " +
        "Without paginationToken, searches synced timeline. With paginationToken, " +
        "fetches from the server-side /messages API (full room history) with date filtering. " +
        "Response includes __nextPageToken when more messages may exist in the date range. " +
        "Each text message is a JSON object with: eventId, sender, timestamp, body, " +
        "and optionally replyToEventId and threadRootEventId.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        startDate: z
          .string()
          .describe("Start date in ISO 8601 format (e.g., 2024-01-01T00:00:00Z)"),
        endDate: z
          .string()
          .describe("End date in ISO 8601 format (e.g., 2024-01-02T00:00:00Z)"),
        limit: z.coerce
          .number()
          .default(50)
          .describe("Maximum number of messages to return per page (default: 50)"),
        paginationToken: z
          .string()
          .optional()
          .describe(
            "Token for fetching older date-filtered messages from full room history. " +
            "Use the __nextPageToken value from a previous response."
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getMessagesByDateHandler
  );

  // Tool: Identify active users
  server.registerTool(
    "identify-active-users",
    {
      title: "Identify Most Active Users",
      description: "Find the most active users in a Matrix room based on message count in synced timeline history (recent messages only, not full room history)",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        limit: z.coerce
          .number()
          .default(10)
          .describe("Maximum number of active users to return (default: 10)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    identifyActiveUsersHandler
  );
};