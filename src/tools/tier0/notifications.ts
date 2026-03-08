import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache } from "../../utils/matrix-errors.js";
import { NotificationCountType } from "matrix-js-sdk";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Tool: Get notification counts
export const getNotificationCountsHandler = async (
  { roomFilter }: { roomFilter?: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const rooms = client.getRooms();
    let filteredRooms = rooms;

    if (roomFilter) {
      filteredRooms = rooms.filter((room) => room.roomId === roomFilter);
      if (filteredRooms.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Room with ID ${roomFilter} not found.`,
            },
          ],
          isError: true,
        };
      }
    }

    let totalUnread = 0;
    let totalMentions = 0;
    const roomNotifications: any[] = [];

    for (const room of filteredRooms) {
      const unreadCount = room.getUnreadNotificationCount() || 0;
      const mentionCount =
        room.getUnreadNotificationCount(NotificationCountType.Highlight) || 0;
      const roomName = room.name || "Unnamed Room";

      totalUnread += unreadCount;
      totalMentions += mentionCount;

      if (unreadCount > 0 || mentionCount > 0 || roomFilter) {
        roomNotifications.push({
          type: "text",
          text: `${roomName} (${room.roomId})
Unread: ${unreadCount} messages
Mentions: ${mentionCount}
Last message: ${
            room.getLastLiveEvent()?.getTs()
              ? new Date(room.getLastLiveEvent()!.getTs()).toLocaleString()
              : "Unknown"
          }`,
        });
      }
    }

    if (roomFilter) {
      return {
        content:
          roomNotifications.length > 0
            ? roomNotifications
            : [
                {
                  type: "text",
                  text: `No notifications in room ${roomFilter}`,
                },
              ],
      };
    }

    // Summary for all rooms
    const summary = {
      type: "text",
      text: `Notification Summary:
Total unread messages: ${totalUnread}
Total mentions/highlights: ${totalMentions}
Rooms with notifications: ${roomNotifications.length}`,
    };

    return {
      content:
        roomNotifications.length > 0
          ? [summary, ...roomNotifications]
          : [
              {
                type: "text",
                text: "No unread notifications across all rooms",
              },
            ],
    };
  } catch (error: any) {
    console.error(`Failed to get notification counts: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to get notification counts - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Get direct messages
export const getDirectMessagesHandler = async (
  { includeEmpty }: { includeEmpty: boolean },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const rooms = client.getRooms();

    // Filter for DM rooms (rooms with exactly 2 members where user is joined)
    const dmRooms = rooms.filter((room) => {
      const memberCount = room.getJoinedMemberCount();
      const membership = room.getMyMembership();
      return membership === "join" && memberCount === 2;
    });

    if (dmRooms.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No direct message conversations found",
          },
        ],
      };
    }

    // Build DM entries with their timestamps for proper sorting
    const dmEntries: { text: string; lastTs: number }[] = [];

    for (const room of dmRooms) {
      const members = room.getJoinedMembers();
      const otherUser = members.find(
        (member) => member.userId !== matrixUserId
      );
      if (!otherUser) continue;

      const lastEvent = room.getLastLiveEvent();
      if (!includeEmpty && !lastEvent) continue;

      const lastTs = lastEvent?.getTs() || 0;
      const lastMessageTime = lastTs
        ? new Date(lastTs).toLocaleString()
        : "No recent messages";
      const lastMessageText =
        lastEvent?.getContent()?.body || "No recent messages";
      const unreadCount = room.getUnreadNotificationCount() || 0;
      const mentionCount =
        room.getUnreadNotificationCount(NotificationCountType.Highlight) || 0;

      dmEntries.push({
        lastTs,
        text: `${otherUser.name || otherUser.userId} (${otherUser.userId})
Room ID: ${room.roomId}
Last message: ${lastMessageTime}
Preview: ${
          lastMessageText.length > 100
            ? lastMessageText.substring(0, 100) + "..."
            : lastMessageText
        }
Unread: ${unreadCount} messages
Mentions: ${mentionCount}`,
      });
    }

    if (dmEntries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: includeEmpty
              ? "No direct message conversations found"
              : "No direct message conversations with recent activity found",
          },
        ],
      };
    }

    // Sort by most recent activity
    dmEntries.sort((a, b) => b.lastTs - a.lastTs);

    return {
      content: [
        {
          type: "text",
          text: `Found ${dmEntries.length} direct message conversation${
            dmEntries.length === 1 ? "" : "s"
          }:`,
        },
        ...dmEntries.map((e) => ({ type: "text" as const, text: e.text })),
      ],
    };
  } catch (error: any) {
    console.error(`Failed to get direct messages: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to get direct messages - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

// Registration function
export const registerNotificationTools: ToolRegistrationFunction = (server) => {
  // Tool: Get notification counts
  server.registerTool(
    "get-notification-counts",
    {
      title: "Get Matrix Notification Counts",
      description: "Get unread message counts and notification status for Matrix rooms",
      inputSchema: {
        roomFilter: z
          .string()
          .optional()
          .describe("Optional room ID to get counts for specific room only"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getNotificationCountsHandler
  );

  // Tool: Get direct messages
  server.registerTool(
    "get-direct-messages",
    {
      title: "Get Direct Message Conversations",
      description: "List all direct message conversations with their recent activity and unread status. " +
        "Note: E2EE message content in DMs may be undecryptable on some homeservers (e.g., Dendrite) due to device key sharing limitations.",
      inputSchema: {
        includeEmpty: z
          .preprocess((v) => (typeof v === "string" ? v === "true" : v), z.boolean())
          .default(false)
          .describe("Include DM rooms with no recent messages (default: false)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getDirectMessagesHandler
  );
};