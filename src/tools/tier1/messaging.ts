import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache } from "../../utils/matrix-errors.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Tool: Send message
export const sendMessageHandler = async (
  { roomId, message, messageType, replyToEventId, threadRootEventId }: {
    roomId: string;
    message: string;
    messageType: "text" | "html" | "emote";
    replyToEventId?: string;
    threadRootEventId?: string;
  },
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

    // Check if user can send messages
    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const userPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const requiredLevel = powerLevelEvent?.getContent()?.events?.["m.room.message"] || 0;
    
    if (userPowerLevel < requiredLevel) {
      return {
        content: [
          {
            type: "text",
            text: `Error: You don't have permission to send messages in this room. Required power level: ${requiredLevel}, your level: ${userPowerLevel}`,
          },
        ],
        isError: true,
      };
    }

    // Auto-detect thread: if replying to a message that's in a thread, stay in that thread.
    // In group rooms (3+ members), auto-create a new thread when replying to a standalone message.
    let effectiveThreadRoot = threadRootEventId;
    if (replyToEventId && !effectiveThreadRoot) {
      const targetEvent = room.findEventById(replyToEventId);
      if (targetEvent) {
        const targetRelatesTo = targetEvent.getContent()?.["m.relates_to"];
        if (targetRelatesTo?.rel_type === "m.thread" || targetRelatesTo?.rel_type === "io.element.thread") {
          // Target is in a thread — stay in it
          effectiveThreadRoot = targetRelatesTo.event_id;
        } else if (room.getJoinedMemberCount() > 2) {
          // Target is standalone in a group room — auto-start a new thread
          effectiveThreadRoot = replyToEventId;
        }
      } else if (room.getJoinedMemberCount() > 2) {
        // Target event not in cache but it's a group room — auto-start thread
        effectiveThreadRoot = replyToEventId;
      }
    }

    // Build the m.relates_to object for threading and/or replies
    let relatesTo: Record<string, any> | undefined;

    if (effectiveThreadRoot) {
      // Matrix threading — use io.element.thread for broad compatibility
      // (Element/Dendrite use this over the spec-standard m.thread)
      relatesTo = {
        rel_type: "io.element.thread",
        event_id: effectiveThreadRoot,
        // If replying within a thread, set is_falling_back so clients render correctly
        "m.in_reply_to": {
          event_id: replyToEventId || effectiveThreadRoot,
        },
        is_falling_back: !replyToEventId,
      };
    } else if (replyToEventId) {
      relatesTo = {
        "m.in_reply_to": {
          event_id: replyToEventId,
        },
      };
    }

    let response;
    if (relatesTo) {
      // Use sendMessage for structured content (threads/replies)
      const msgtype = messageType === "html" ? "m.text"
        : messageType === "emote" ? "m.emote"
        : "m.text";
      const content: Record<string, any> = {
        msgtype,
        body: message,
        "m.relates_to": relatesTo,
      };
      if (messageType === "html") {
        content.format = "org.matrix.custom.html";
        content.formatted_body = message;
      }
      response = await client.sendEvent(roomId, "m.room.message" as any, content as any);
    } else if (messageType === "html") {
      response = await client.sendHtmlMessage(roomId, message, message);
    } else if (messageType === "emote") {
      response = await client.sendEmoteMessage(roomId, message);
    } else {
      response = await client.sendTextMessage(roomId, message);
    }

    const extras = [
      replyToEventId ? `reply to ${replyToEventId}` : "",
      effectiveThreadRoot ? `thread ${effectiveThreadRoot}` : "",
    ].filter(Boolean).join(", ");

    return {
      content: [
        {
          type: "text",
          text: `Message sent successfully to ${room.name || roomId}
Event ID: ${response.event_id}
Message type: ${messageType}${extras ? ` (${extras})` : ""}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to send message: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to send message - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Send direct message
export const sendDirectMessageHandler = async (
  { targetUserId, message }: { targetUserId: string; message: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    
    // First, try to find an existing DM room
    const rooms = client.getRooms();
    let dmRoom = rooms.find((room) => {
      const members = room.getJoinedMembers();
      return (
        members.length === 2 &&
        members.some((member) => member.userId === targetUserId) &&
        members.some((member) => member.userId === matrixUserId)
      );
    });

    let roomId: string;
    
    if (dmRoom) {
      // Use existing DM room
      roomId = dmRoom.roomId;
    } else {
      // Create new DM room with encryption enabled (matches Element's default behavior)
      const createResponse = await client.createRoom({
        is_direct: true,
        invite: [targetUserId],
        preset: "trusted_private_chat" as any,
        initial_state: [
          {
            type: "m.room.encryption",
            state_key: "",
            content: {
              algorithm: "m.megolm.v1.aes-sha2",
            },
          },
          {
            type: "m.room.guest_access",
            content: {
              guest_access: "forbidden",
            },
          },
        ],
      });
      roomId = createResponse.room_id;
      
      // Mark as DM in account data
      try {
        const existingDmEvent = client.getAccountData("m.direct" as any) as any;
        const existingDmContent = existingDmEvent?.getContent?.() ?? existingDmEvent ?? {};
        const dmData: { [key: string]: string[] } = {};
        // Safely extract only valid room ID arrays from m.direct content
        for (const [userId, rooms] of Object.entries(existingDmContent)) {
          if (Array.isArray(rooms)) {
            dmData[userId] = rooms.filter((r): r is string => typeof r === "string" && r.startsWith("!"));
          }
        }
        if (!dmData[targetUserId]) {
          dmData[targetUserId] = [];
        }
        dmData[targetUserId].push(roomId);
        await client.setAccountData("m.direct" as any, dmData as any);
      } catch (error) {
        console.warn("Could not update m.direct account data:", error);
      }
    }

    // Send the message
    const response = await client.sendTextMessage(roomId, message);
    
    // Get room info for response
    const finalRoom = client.getRoom(roomId) || dmRoom;
    const roomName = finalRoom?.name || `DM with ${targetUserId}`;

    return {
      content: [
        {
          type: "text",
          text: `Direct message sent successfully to ${targetUserId}
Room: ${roomName} (${roomId})
Event ID: ${response.event_id}
${!dmRoom ? "New DM room created" : "Used existing DM room"}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to send direct message: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    
    // Provide more specific error messages
    let errorMessage = `Error: Failed to send direct message - ${error.message}`;
    if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: User ${targetUserId} not found or not accessible from your homeserver`;
    } else if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: Cannot send direct message to ${targetUserId} - they may have blocked DMs or be on a different homeserver`;
    }
    
    return {
      content: [
        {
          type: "text",
          text: errorMessage,
        },
      ],
      isError: true,
    };
  }
};

// Registration function
export const registerMessagingTools: ToolRegistrationFunction = (server) => {
  // Tool: Send message
  server.registerTool(
    "send-message",
    {
      title: "Send Matrix Message",
      description:
        "Send a text message to a Matrix room, with support for plain text, HTML formatting, replies, and threads. " +
        "Use replyToEventId to quote-reply to a specific message. " +
        "Use threadRootEventId to send a message in a thread (the root event ID starts the thread). " +
        "You can combine both to reply to a specific message within a thread. " +
        "Get eventIds from get-room-messages or wait-for-messages. " +
        "Auto-threading: In group rooms (3+ members), using replyToEventId automatically creates or joins a thread. " +
        "If the target message is in a thread, the reply stays in that thread. " +
        "If the target message is standalone, a new thread is started. " +
        "In DMs (2 members), replyToEventId creates an inline reply without threading.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        message: z.string().describe("The message content to send"),
        messageType: z
          .enum(["text", "html", "emote"])
          .default("text")
          .describe("Type of message: text (plain), html (formatted), or emote (action)"),
        replyToEventId: z
          .string()
          .optional()
          .describe("Event ID to reply to. Get this from the eventId field in get-room-messages or wait-for-messages results."),
        threadRootEventId: z
          .string()
          .optional()
          .describe("Event ID of the thread root to send this message as part of a thread. " +
            "If the message you want to reply to has a threadRootEventId, use that value here to stay in the same thread."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    sendMessageHandler
  );

  // Tool: Send direct message
  server.registerTool(
    "send-direct-message",
    {
      title: "Send Direct Message",
      description: "Send a direct message to a Matrix user. Creates a new DM room if one doesn't exist. " +
        "Note: E2EE message content in DMs may be undecryptable on some homeservers (e.g., Dendrite) due to device key sharing limitations.",
      inputSchema: {
        targetUserId: z
          .string()
          .describe("Target user's Matrix ID (e.g., @user:domain.com)"),
        message: z.string().describe("The message content to send"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    sendDirectMessageHandler
  );
};