import { z } from "zod";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import {
  setSubscription,
  getSubscription,
} from "../../matrix/notificationSubscriptions.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

export const subscribeNotificationsHandler = async (
  { rooms, users, dms, all, mentionsOnly, silentRooms }: { rooms?: string[]; users?: string[]; dms?: boolean; all?: boolean; mentionsOnly?: boolean; silentRooms?: string[] },
  _extra?: any,
  serverRef?: { sendResourceListChanged: () => void }
) => {
  setSubscription({ rooms, users, dms, all, mentionsOnly, silentRooms });
  const sub = getSubscription();
  const parts: string[] = [];
  if (sub?.all) parts.push("all events");
  if (sub?.dms) parts.push("all DMs");
  if (sub?.mentionsOnly) parts.push("@mentions in all rooms");
  if (sub?.rooms?.length) parts.push(`rooms: ${sub.rooms.join(", ")}`);
  if (sub?.users?.length) parts.push(`users: ${sub.users.join(", ")}`);
  if (sub?.silentRooms?.length) parts.push(`silent rooms (queue only): ${sub.silentRooms.join(", ")}`);

  // Notify immediately if there are already queued messages
  const pending = getMessageQueue().peek();
  if (pending.count > 0 && parts.length > 0) {
    try { serverRef?.sendResourceListChanged(); } catch { /* transport may not be ready */ }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: parts.length
          ? `Subscribed to notifications for: ${parts.join("; ")}`
          : "Subscription set but no filters specified — no notifications will fire. Use all, dms, rooms, or users.",
      },
    ],
  };
};

export const unsubscribeNotificationsHandler = async () => {
  setSubscription(null);
  return {
    content: [
      {
        type: "text" as const,
        text: "Unsubscribed from all notifications.",
      },
    ],
  };
};

export const registerNotificationSubscribeTools: ToolRegistrationFunction = (
  server
) => {
  server.registerTool(
    "subscribe-notifications",
    {
      title: "Subscribe to Notifications",
      description:
        "Subscribe to MCP notifications for specific rooms, users, or DMs. " +
        "By default, the server sends no notifications — you must subscribe first. " +
        "Notifications are delivered via sendResourceListChanged and picked up by mcp-notify. " +
        "Call with all=true to receive all notifications, or specify rooms/users/dms for filtering. " +
        "Use silentRooms for rooms that should queue messages without triggering mcp-notify — useful for batch-checking on a schedule.",
      inputSchema: {
        rooms: z
          .array(z.string())
          .optional()
          .describe("Room IDs to receive notifications for"),
        users: z
          .array(z.string())
          .optional()
          .describe("User IDs (senders) to receive notifications for"),
        dms: z
          .boolean()
          .optional()
          .describe("Subscribe to all direct messages"),
        all: z
          .boolean()
          .optional()
          .describe("Subscribe to all notifications"),
        mentionsOnly: z
          .boolean()
          .optional()
          .describe("Additionally subscribe to @mentions of the bot in any joined room"),
        silentRooms: z
          .array(z.string())
          .optional()
          .describe("Room IDs that queue messages but do NOT trigger mcp-notify notifications. Messages are retrievable via get-queued-messages for batch-checking on a schedule."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: any) => {
      return subscribeNotificationsHandler(input, undefined, server);
    }
  );

  server.registerTool(
    "unsubscribe-notifications",
    {
      title: "Unsubscribe from Notifications",
      description:
        "Remove all notification subscriptions. The server will stop sending MCP notifications.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    unsubscribeNotificationsHandler
  );
};
