import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache } from "../../utils/matrix-errors.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Tool: Set room name
export const setRoomNameHandler = async (
  { roomId, roomName }: { roomId: string; roomName: string },
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

    const currentName = room.name || "Unnamed Room";
    
    // Check if user has permission to change room name
    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const userPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const nameChangeLevel = powerLevelEvent?.getContent()?.events?.["m.room.name"] || 
                          powerLevelEvent?.getContent()?.state_default || 50;
    
    if (userPowerLevel < nameChangeLevel) {
      return {
        content: [
          {
            type: "text",
            text: `Error: You don't have permission to change the room name. Required power level: ${nameChangeLevel}, your level: ${userPowerLevel}`,
          },
        ],
        isError: true,
      };
    }

    // Set the room name
    await client.setRoomName(roomId, roomName);

    return {
      content: [
        {
          type: "text",
          text: `Successfully updated room name
Room ID: ${roomId}
Previous name: ${currentName}
New name: ${roomName}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to set room name: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    
    // Provide more specific error messages
    let errorMessage = `Error: Failed to set room name to "${roomName}" - ${error.message}`;
    if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: Room ${roomId} not found`;
    } else if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: You don't have permission to change the room name`;
    } else if (error.message.includes("M_LIMIT_EXCEEDED")) {
      errorMessage = `Error: Rate limited when changing room name - please try again later`;
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

// Tool: Set room topic
export const setRoomTopicHandler = async (
  { roomId, topic }: { roomId: string; topic: string },
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
    const currentTopic = room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic || "No topic set";
    
    // Check if user has permission to change room topic
    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const userPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const topicChangeLevel = powerLevelEvent?.getContent()?.events?.["m.room.topic"] || 
                           powerLevelEvent?.getContent()?.state_default || 50;
    
    if (userPowerLevel < topicChangeLevel) {
      return {
        content: [
          {
            type: "text",
            text: `Error: You don't have permission to change the room topic. Required power level: ${topicChangeLevel}, your level: ${userPowerLevel}`,
          },
        ],
        isError: true,
      };
    }

    // Set the room topic
    await client.setRoomTopic(roomId, topic);

    return {
      content: [
        {
          type: "text",
          text: `Successfully updated room topic for ${roomName}
Room ID: ${roomId}
Previous topic: ${currentTopic}
New topic: ${topic}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to set room topic: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    
    // Provide more specific error messages
    let errorMessage = `Error: Failed to set room topic - ${error.message}`;
    if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: Room ${roomId} not found`;
    } else if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: You don't have permission to change the room topic`;
    } else if (error.message.includes("M_LIMIT_EXCEEDED")) {
      errorMessage = `Error: Rate limited when changing room topic - please try again later`;
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

// Tool: Set power level
export const setPowerLevelHandler = async (
  { roomId, targetUserId, powerLevel }: { roomId: string; targetUserId: string; powerLevel: number },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [{ type: "text" as const, text: `Error: Room ${roomId} not found. You may not be a member of this room.` }],
        isError: true,
      };
    }

    const roomName = room.name || "Unnamed Room";
    const ownPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const targetMember = room.getMember(targetUserId);
    const currentTargetLevel = targetMember?.powerLevel || 0;

    // Check: can't set power level higher than own (unless setting yourself)
    // Matrix spec allows promoting to your own level, just not above
    if (targetUserId !== matrixUserId && powerLevel > ownPowerLevel) {
      return {
        content: [{ type: "text" as const, text: `Error: Cannot set power level to ${powerLevel} — your own level is ${ownPowerLevel}. You can only set levels up to your own.` }],
        isError: true,
      };
    }

    // Check: can't demote someone at or above own level (unless self)
    if (targetUserId !== matrixUserId && currentTargetLevel >= ownPowerLevel) {
      return {
        content: [{ type: "text" as const, text: `Error: Cannot change power level of ${targetUserId} — their level (${currentTargetLevel}) is at or above yours (${ownPowerLevel}).` }],
        isError: true,
      };
    }

    await client.setPowerLevel(roomId, targetUserId, powerLevel);

    return {
      content: [{
        type: "text" as const,
        text: `Successfully updated power level in ${roomName}\nRoom ID: ${roomId}\nUser: ${targetUserId}\nPrevious level: ${currentTargetLevel}\nNew level: ${powerLevel}`,
      }],
    };
  } catch (error: any) {
    console.error(`Failed to set power level: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);

    let errorMessage = `Error: Failed to set power level - ${error.message}`;
    if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: You don't have permission to change power levels in this room`;
    } else if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: Room ${roomId} not found`;
    }

    return {
      content: [{ type: "text" as const, text: errorMessage }],
      isError: true,
    };
  }
};

// Valid join rule values per Matrix spec
const VALID_JOIN_RULES = ["public", "invite", "knock", "restricted"] as const;
type JoinRule = typeof VALID_JOIN_RULES[number];

// Tool: Set room join rules
export const setJoinRulesHandler = async (
  { roomId, joinRule }: { roomId: string; joinRule: JoinRule },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [{ type: "text" as const, text: `Error: Room ${roomId} not found. You may not be a member of this room.` }],
        isError: true,
      };
    }

    const roomName = room.name || "Unnamed Room";
    const currentRule = room.currentState.getStateEvents("m.room.join_rules", "")?.getContent()?.join_rule || "unknown";

    // Check permission
    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const userPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const requiredLevel = powerLevelEvent?.getContent()?.events?.["m.room.join_rules"] ||
                          powerLevelEvent?.getContent()?.state_default || 50;

    if (userPowerLevel < requiredLevel) {
      return {
        content: [{ type: "text" as const, text: `Error: You don't have permission to change join rules. Required power level: ${requiredLevel}, your level: ${userPowerLevel}` }],
        isError: true,
      };
    }

    await client.sendStateEvent(roomId, "m.room.join_rules" as any, { join_rule: joinRule });

    return {
      content: [{
        type: "text" as const,
        text: `Successfully updated join rules for ${roomName}\nRoom ID: ${roomId}\nPrevious: ${currentRule}\nNew: ${joinRule}`,
      }],
    };
  } catch (error: any) {
    console.error(`Failed to set join rules: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);

    let errorMessage = `Error: Failed to set join rules - ${error.message}`;
    if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: You don't have permission to change join rules in this room`;
    } else if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: Room ${roomId} not found`;
    }

    return {
      content: [{ type: "text" as const, text: errorMessage }],
      isError: true,
    };
  }
};

// Valid history visibility values per Matrix spec
const VALID_HISTORY_VISIBILITY = ["invited", "joined", "shared", "world_readable"] as const;
type HistoryVisibility = typeof VALID_HISTORY_VISIBILITY[number];

// Tool: Set room history visibility
export const setHistoryVisibilityHandler = async (
  { roomId, historyVisibility }: { roomId: string; historyVisibility: HistoryVisibility },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [{ type: "text" as const, text: `Error: Room ${roomId} not found. You may not be a member of this room.` }],
        isError: true,
      };
    }

    const roomName = room.name || "Unnamed Room";
    const currentVisibility = room.currentState.getStateEvents("m.room.history_visibility", "")?.getContent()?.history_visibility || "unknown";

    // Check permission
    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const userPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const requiredLevel = powerLevelEvent?.getContent()?.events?.["m.room.history_visibility"] ||
                          powerLevelEvent?.getContent()?.state_default || 50;

    if (userPowerLevel < requiredLevel) {
      return {
        content: [{ type: "text" as const, text: `Error: You don't have permission to change history visibility. Required power level: ${requiredLevel}, your level: ${userPowerLevel}` }],
        isError: true,
      };
    }

    await client.sendStateEvent(roomId, "m.room.history_visibility" as any, { history_visibility: historyVisibility });

    return {
      content: [{
        type: "text" as const,
        text: `Successfully updated history visibility for ${roomName}\nRoom ID: ${roomId}\nPrevious: ${currentVisibility}\nNew: ${historyVisibility}`,
      }],
    };
  } catch (error: any) {
    console.error(`Failed to set history visibility: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);

    let errorMessage = `Error: Failed to set history visibility - ${error.message}`;
    if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: You don't have permission to change history visibility in this room`;
    } else if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: Room ${roomId} not found`;
    }

    return {
      content: [{ type: "text" as const, text: errorMessage }],
      isError: true,
    };
  }
};

// Registration function
export const registerRoomAdminTools: ToolRegistrationFunction = (server) => {
  // Tool: Set room name
  server.registerTool(
    "set-room-name",
    {
      title: "Set Matrix Room Name",
      description: "Update the display name of a Matrix room. Requires appropriate permissions in the room",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        roomName: z.string().describe("New name for the room"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    setRoomNameHandler
  );

  // Tool: Set room topic
  server.registerTool(
    "set-room-topic",
    {
      title: "Set Matrix Room Topic",
      description: "Update the topic/description of a Matrix room. Requires appropriate permissions in the room",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        topic: z.string().describe("New topic/description for the room"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    setRoomTopicHandler
  );

  // Tool: Set power level
  server.registerTool(
    "set-power-level",
    {
      title: "Set User Power Level",
      description:
        "Set the power level of a user in a Matrix room. " +
        "Common levels: 0 = default, 50 = moderator, 100 = admin. " +
        "You can only set levels up to your own, and cannot change users at or above your level.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        targetUserId: z.string().describe("Matrix user ID to set power level for (e.g., @user:domain.com)"),
        powerLevel: z.coerce.number().describe("Power level to set (0 = default, 50 = moderator, 100 = admin)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    setPowerLevelHandler
  );

  // Tool: Set room join rules
  server.registerTool(
    "set-room-join-rules",
    {
      title: "Set Room Join Rules",
      description:
        "Set who can join a Matrix room. " +
        "Options: 'public' (anyone can join), 'invite' (invitation only), " +
        "'knock' (users can request to join), 'restricted' (limited by space membership). " +
        "Requires appropriate permissions.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        joinRule: z.enum(["public", "invite", "knock", "restricted"]).describe("Join rule: public, invite, knock, or restricted"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    setJoinRulesHandler
  );

  // Tool: Set room history visibility
  server.registerTool(
    "set-room-history-visibility",
    {
      title: "Set Room History Visibility",
      description:
        "Control how much room history is visible to new members. " +
        "Options: 'shared' (all history visible to members), 'invited' (history from invite onward), " +
        "'joined' (history from join onward), 'world_readable' (anyone can read history). " +
        "Requires appropriate permissions.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        historyVisibility: z.enum(["invited", "joined", "shared", "world_readable"]).describe("History visibility: invited, joined, shared, or world_readable"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    setHistoryVisibilityHandler
  );
};