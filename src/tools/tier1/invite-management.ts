import { z } from "zod";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache, getDiagnosticHint } from "../../utils/matrix-errors.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Tool: Invite user
export const inviteUserHandler = async (
  { roomId, targetUserId }: { roomId: string; targetUserId: string },
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

    const roomName = room.name || "Unnamed Room";

    // Check if user is already in the room
    const existingMember = room.getMember(targetUserId);
    if (existingMember) {
      const membership = existingMember.membership;
      if (membership === "join") {
        return {
          content: [
            {
              type: "text",
              text: `User ${targetUserId} is already a member of room ${roomName}`,
            },
          ],
        };
      } else if (membership === "invite") {
        return {
          content: [
            {
              type: "text",
              text: `User ${targetUserId} has already been invited to room ${roomName}`,
            },
          ],
        };
      } else if (membership === "ban") {
        return {
          content: [
            {
              type: "text",
              text: `User ${targetUserId} is banned from room ${roomName}. Cannot invite banned users.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Check if user has permission to invite
    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const userPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const inviteLevel = powerLevelEvent?.getContent()?.invite || 0;

    if (userPowerLevel < inviteLevel) {
      return {
        content: [
          {
            type: "text",
            text: `Error: You don't have permission to invite users to this room. Required power level: ${inviteLevel}, your level: ${userPowerLevel}`,
          },
        ],
        isError: true,
      };
    }

    // Invite the user
    await client.invite(roomId, targetUserId);

    return {
      content: [
        {
          type: "text",
          text: `Successfully invited ${targetUserId} to room ${roomName}
Room ID: ${roomId}
The user will receive an invitation and can choose to join the room.`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to invite user: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);

    // Provide more specific error messages
    let errorMessage = `Error: Failed to invite ${targetUserId} to room ${roomId} - ${error.message}`;
    if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: User ${targetUserId} not found or room ${roomId} not found`;
    } else if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: Cannot invite ${targetUserId} to room - you may not have permission or the user may be banned`;
    } else if (error.message.includes("M_LIMIT_EXCEEDED")) {
      errorMessage = `Error: Rate limited when inviting user - please try again later`;
    }
    errorMessage += `\n${getDiagnosticHint(error)}`;

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
export const registerInviteManagementTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "invite-user",
    {
      title: "Invite User to Matrix Room",
      description: "Invite a user to a Matrix room. Requires appropriate permissions in the room",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        targetUserId: z
          .string()
          .describe("Target user's Matrix ID to invite (e.g., @user:domain.com)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    inviteUserHandler
  );
};
