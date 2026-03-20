import { z } from "zod";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import {
  setSubscription,
  getSubscription,
} from "../../matrix/notificationSubscriptions.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

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
        "Call with all=true to receive all notifications, or specify rooms/users/dms for filtering.",
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
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ rooms, users, dms, all, mentionsOnly }: { rooms?: string[]; users?: string[]; dms?: boolean; all?: boolean; mentionsOnly?: boolean }) => {
      setSubscription({ rooms, users, dms, all, mentionsOnly });
      const sub = getSubscription();
      const parts: string[] = [];
      if (sub?.all) parts.push("all events");
      if (sub?.dms) parts.push("all DMs");
      if (sub?.mentionsOnly) parts.push("@mentions in all rooms");
      if (sub?.rooms?.length) parts.push(`rooms: ${sub.rooms.join(", ")}`);
      if (sub?.users?.length) parts.push(`users: ${sub.users.join(", ")}`);

      // Notify immediately if there are already queued messages
      const pending = getMessageQueue().peek();
      if (pending.count > 0 && parts.length > 0) {
        try { server.sendResourceListChanged(); } catch { /* transport may not be ready */ }
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
    async () => {
      setSubscription(null);
      return {
        content: [
          {
            type: "text" as const,
            text: "Unsubscribed from all notifications.",
          },
        ],
      };
    }
  );
};
