import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EventType, MatrixClient } from "matrix-js-sdk";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache, getDiagnosticHint } from "../../utils/matrix-errors.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Tool: Search public rooms
export const searchPublicRoomsHandler = async (
  { searchTerm, server, limit }: { searchTerm?: string; server?: string; limit: number },
  { requestInfo, authInfo }: any
): Promise<CallToolResult> => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const searchOptions: any = {
      limit,
      include_all_known_networks: true,
    };

    if (server) {
      searchOptions.server = server;
    }

    if (searchTerm) {
      searchOptions.filter = {
        generic_search_term: searchTerm,
      };
    }

    const publicRooms = await client.publicRooms(searchOptions);

    if (!publicRooms.chunk || publicRooms.chunk.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: searchTerm
              ? `No public rooms found matching "${searchTerm}"`
              : "No public rooms found",
          },
        ],
      };
    }

    const roomList = publicRooms.chunk.map((room: any) => {
      const name = room.name || "Unnamed Room";
      const topic = room.topic || "No topic";
      const members = room.num_joined_members || 0;
      const alias = room.canonical_alias || room.room_id;
      const avatar = room.avatar_url ? "Has avatar" : "No avatar";

      return {
        type: "text" as const,
        text: `${name} (${alias})
Topic: ${topic}
Members: ${members}
Avatar: ${avatar}
Room ID: ${room.room_id}`,
      };
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${publicRooms.chunk.length} public rooms${
            searchTerm ? ` matching "${searchTerm}"` : ""
          }:`,
        },
        ...roomList,
      ],
    };
  } catch (error: any) {
    console.error(`Failed to search public rooms: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: Failed to search public rooms - ${error.message}\n${getDiagnosticHint(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// Client-side fallback: scan synced timeline events
function clientSideSearch(
  client: MatrixClient,
  query: string,
  roomId: string | undefined,
  sender: string | undefined,
  limit: number,
): { header: string; results: { type: "text"; text: string }[] } | null {
  const queryLower = query.toLowerCase();

  const rooms = roomId
    ? [client.getRoom(roomId)].filter(Boolean)
    : client.getRooms().filter((r) => r.getMyMembership() === "join");

  if (rooms.length === 0) return null;

  interface Match { roomId: string; roomName: string; eventId: string; sender: string; timestamp: number; body: string }
  const matches: Match[] = [];

  for (const room of rooms) {
    if (!room) continue;
    for (const event of room.getLiveTimeline().getEvents()) {
      const evtType = event.getType();
      if (evtType !== EventType.RoomMessage && evtType !== EventType.RoomMessageEncrypted) continue;
      const content = event.getClearContent?.() || event.getContent();
      if (!content?.body) continue;
      if (content["m.relates_to"]?.rel_type === "m.replace") continue;
      if (event.isRedacted()) continue;
      const body = String(content.body);
      if (!body.toLowerCase().includes(queryLower)) continue;
      const evtSender = event.getSender() || "";
      if (sender && evtSender !== sender) continue;
      matches.push({
        roomId: room.roomId, roomName: room.name || room.roomId,
        eventId: event.getId() || "", sender: evtSender,
        timestamp: event.getTs(), body,
      });
    }
  }

  matches.sort((a, b) => b.timestamp - a.timestamp);
  const limited = matches.slice(0, limit);

  if (limited.length === 0) return null;

  const header = `Found ${matches.length} message${matches.length !== 1 ? "s" : ""} matching "${query}" (synced history)${matches.length > limit ? ` (showing ${limit})` : ""}:`;
  const results = limited.map((m) => ({
    type: "text" as const,
    text: JSON.stringify({
      eventId: m.eventId, roomName: m.roomName, roomId: m.roomId,
      sender: m.sender, timestamp: new Date(m.timestamp).toISOString(), body: m.body,
    }),
  }));

  return { header, results };
}

// Tool: Search message content across rooms (server-side with client-side fallback)
export const searchMessagesHandler = async (
  { query, roomId, sender, limit }: { query: string; roomId?: string; sender?: string; limit: number },
  { requestInfo, authInfo }: any
): Promise<CallToolResult> => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    // Try server-side search first (full history)
    try {
      const filter: any = {};
      if (roomId) filter.rooms = [roomId];
      if (sender) filter.senders = [sender];

      const searchResults = await client.searchRoomEvents({ term: query, filter });
      const results = searchResults.results || [];
      const totalCount = searchResults.count ?? results.length;

      if (results.length === 0) {
        const scope = roomId
          ? `room ${client.getRoom(roomId)?.name || roomId}`
          : "any joined room";
        return {
          content: [{ type: "text" as const, text: `No messages matching "${query}" in ${scope}.` }],
        };
      }

      const limited = results.slice(0, limit);
      const header = `Found ${totalCount} message${totalCount !== 1 ? "s" : ""} matching "${query}"${totalCount > limit ? ` (showing ${limit})` : ""}:`;

      const formatted = limited.map((sr) => {
        const event = sr.context.getEvent();
        const content = event.getClearContent?.() || event.getContent();
        const evtRoomId = event.getRoomId() || "";
        const room = client.getRoom(evtRoomId);
        return {
          type: "text" as const,
          text: JSON.stringify({
            eventId: event.getId() || "", roomName: room?.name || evtRoomId,
            roomId: evtRoomId, sender: event.getSender() || "",
            timestamp: new Date(event.getTs()).toISOString(), body: String(content?.body || ""),
          }),
        };
      });

      return { content: [{ type: "text" as const, text: header }, ...formatted] };
    } catch (searchErr: any) {
      // Server-side search not available — fall back to client-side
      if (searchErr.httpStatus === 501 || searchErr.httpStatus === 404 || searchErr.httpStatus === 405) {
        const fallback = clientSideSearch(client, query, roomId, sender, limit);
        if (!fallback) {
          const scope = roomId
            ? `room ${client.getRoom(roomId)?.name || roomId}`
            : "any joined room";
          return {
            content: [{ type: "text" as const, text: `No messages matching "${query}" in ${scope}.` }],
          };
        }
        return { content: [{ type: "text" as const, text: fallback.header }, ...fallback.results] };
      }
      throw searchErr;
    }
  } catch (error: any) {
    console.error(`Failed to search messages: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [{ type: "text" as const, text: `Error: Failed to search messages - ${error.message}\n${getDiagnosticHint(error)}` }],
      isError: true,
    };
  }
};

// Registration function
export const registerSearchTools: ToolRegistrationFunction = (server) => {
  // Tool: Search public rooms
  server.registerTool(
    "search-public-rooms",
    {
      title: "Search Public Matrix Rooms",
      description: "Search for public Matrix rooms that you can join, with optional filtering by name or topic",
      inputSchema: {
        searchTerm: z
          .string()
          .optional()
          .describe("Search term to filter rooms by name or topic"),
        server: z
          .string()
          .optional()
          .describe("Specific server to search rooms on (defaults to your homeserver)"),
        limit: z.coerce
          .number()
          .default(20)
          .describe("Maximum number of rooms to return (default: 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    searchPublicRoomsHandler
  );

  // Tool: Search message content
  server.registerTool(
    "search-messages",
    {
      title: "Search Message Content",
      description:
        "Search message content across joined rooms by keyword. " +
        "Uses server-side full-text search when available (searches full history). " +
        "Falls back to scanning synced message history if the homeserver doesn't support search. " +
        "Returns matching messages with room name, sender, timestamp, and body. " +
        "Optionally filter by specific room or sender.",
      inputSchema: {
        query: z.string().describe("Text to search for in message bodies (case-insensitive)"),
        roomId: z
          .string()
          .optional()
          .describe("Limit search to a specific room ID"),
        sender: z
          .string()
          .optional()
          .describe("Filter results to messages from a specific sender (full Matrix user ID)"),
        limit: z.coerce
          .number()
          .default(20)
          .describe("Maximum number of results to return (default: 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    searchMessagesHandler
  );
};