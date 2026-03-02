import { z } from "zod";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Tool: Redact (delete) a message
export const redactEventHandler = async (
  { roomId, eventId, reason }: { roomId: string; eventId: string; reason?: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    await client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);

    return {
      content: [
        {
          type: "text" as const,
          text: `Message redacted successfully.\nEvent ID: ${eventId}${reason ? `\nReason: ${reason}` : ""}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to redact event: ${error.message}`);
    removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [{ type: "text" as const, text: `Error: Failed to redact event - ${error.message}` }],
      isError: true,
    };
  }
};

// Tool: Send an emoji reaction
export const sendReactionHandler = async (
  { roomId, eventId, emoji }: { roomId: string; eventId: string; emoji: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const response = await client.sendEvent(roomId, "m.reaction" as any, {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key: emoji,
      },
    } as any);

    return {
      content: [
        {
          type: "text" as const,
          text: `Reaction ${emoji} sent.\nEvent ID: ${response.event_id}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to send reaction: ${error.message}`);
    removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [{ type: "text" as const, text: `Error: Failed to send reaction - ${error.message}` }],
      isError: true,
    };
  }
};

// Tool: Edit (replace) an existing message
export const editMessageHandler = async (
  { roomId, eventId, newBody }: { roomId: string; eventId: string; newBody: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const response = await client.sendEvent(roomId, "m.room.message" as any, {
      msgtype: "m.text",
      body: `* ${newBody}`,
      "m.new_content": {
        msgtype: "m.text",
        body: newBody,
      },
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: eventId,
      },
    } as any);

    return {
      content: [
        {
          type: "text" as const,
          text: `Message edited successfully.\nOriginal event: ${eventId}\nEdit event: ${response.event_id}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to edit message: ${error.message}`);
    removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [{ type: "text" as const, text: `Error: Failed to edit message - ${error.message}` }],
      isError: true,
    };
  }
};

// Registration
export const registerMessageActionTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "redact-event",
    {
      title: "Redact Matrix Message",
      description: "Redact (delete) a message in a Matrix room. The message content is replaced with a redaction notice. You can only redact your own messages unless you have moderator permissions.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        eventId: z.string().describe("Event ID of the message to redact"),
        reason: z.string().optional().describe("Optional reason for the redaction"),
      },
    },
    redactEventHandler
  );

  server.registerTool(
    "send-reaction",
    {
      title: "Send Emoji Reaction",
      description: "React to a Matrix message with an emoji. Standard emoji reactions (e.g., 👍, ❤️, 😂) are widely supported.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        eventId: z.string().describe("Event ID of the message to react to"),
        emoji: z.string().describe("Emoji to react with (e.g., '👍', '❤️', '😂')"),
      },
    },
    sendReactionHandler
  );

  server.registerTool(
    "edit-message",
    {
      title: "Edit Matrix Message",
      description: "Edit a previously sent message in a Matrix room. Only works on your own messages. Creates a replacement event that clients display as the edited version.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        eventId: z.string().describe("Event ID of the message to edit"),
        newBody: z.string().describe("The new message content to replace the original with"),
      },
    },
    editMessageHandler
  );
};
