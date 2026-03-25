import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Import tool registration functions
// Tier 0 (Read-only tools)
import { registerRoomTools } from "./tools/tier0/rooms.js";
import { registerMessageTools } from "./tools/tier0/messages.js";
import { registerUserTools } from "./tools/tier0/users.js";
import { registerSearchTools } from "./tools/tier0/search.js";
import { registerNotificationTools } from "./tools/tier0/notifications.js";
import { registerWaitForMessagesTools } from "./tools/tier0/wait-for-messages.js";
import { registerGetQueuedMessagesTools } from "./tools/tier0/get-queued-messages.js";
import { registerInviteTools } from "./tools/tier0/invites.js";
import { registerReplayQueueTools } from "./tools/tier0/replay-queue.js";
import { registerEventContextTools } from "./tools/tier0/event-context.js";

// Tier 1 (Action tools)
import { registerMessagingTools } from "./tools/tier1/messaging.js";
import { registerRoomManagementTools } from "./tools/tier1/room-management.js";
import { registerRoomAdminTools } from "./tools/tier1/room-admin.js";
import { registerMessageActionTools } from "./tools/tier1/message-actions.js";
import { registerServerAdminTools } from "./tools/tier1/server-admin.js";
import { registerThreadMessageTools } from "./tools/tier1/thread-messages.js";
import { registerNotificationSubscribeTools } from "./tools/tier1/notification-subscribe.js";

// Create MCP server instance
const server = new McpServer(
  {
    name: "matrix-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      logging: {},
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions:
      "Messages from Matrix arrive as <channel source=\"matrix-server\" ...> tags. " +
      "Attributes include: sender (full Matrix user ID), room_name, room_id, event_id, is_dm. " +
      "Thread messages include a thread_root attribute. Replies include reply_to. " +
      "For DMs, reply using the send-direct-message tool with the sender's user ID. " +
      "For room messages, reply using the send-message tool with the room_id. " +
      "Use get-queued-messages for batch retrieval of accumulated messages. " +
      "Silent rooms queue messages without channel delivery — check them with get-queued-messages on a schedule.",
  }
);

// Register all tool modules
// Tier 0: Read-only Matrix tools
registerRoomTools(server);        // list-joined-rooms, get-room-info, get-room-members
registerMessageTools(server);     // get-room-messages, get-messages-by-date, identify-active-users
registerUserTools(server);        // get-user-profile, get-my-profile, get-all-users
registerSearchTools(server);      // search-public-rooms
registerNotificationTools(server); // get-notification-counts, get-direct-messages
registerWaitForMessagesTools(server); // wait-for-messages
registerGetQueuedMessagesTools(server); // get-queued-messages
registerInviteTools(server);          // get-pending-invites
registerReplayQueueTools(server);     // replay-queue
registerEventContextTools(server);   // get-event-context

// Tier 1: Action Matrix tools
registerMessagingTools(server);       // send-message, send-direct-message
registerRoomManagementTools(server);  // create-room, join-room, leave-room, invite-user
registerRoomAdminTools(server);       // set-room-name, set-room-topic, set-room-join-rules, set-room-history-visibility
registerMessageActionTools(server);  // redact-event, send-reaction, edit-message
registerServerAdminTools(server);    // restart-server, get-pipeline-metrics, get-server-health
registerThreadMessageTools(server);  // get-thread-messages
registerNotificationSubscribeTools(server); // subscribe-notifications, unsubscribe-notifications

export default server;