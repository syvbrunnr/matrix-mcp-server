import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache } from "../../utils/matrix-errors.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

// Tool: Get user profile
export const getUserProfileHandler = async (
  { targetUserId }: { targetUserId: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const user = client.getUser(targetUserId);
    if (!user) {
      return {
        content: [
          {
            type: "text",
            text: `Error: User ${targetUserId} not found or not known to your client.`,
          },
        ],
        isError: true,
      };
    }

    const displayName = user.displayName || "No display name set";
    const avatarUrl = user.avatarUrl || "No avatar set";
    const presence = user.presence || "unknown";
    const presenceStatus = user.presenceStatusMsg || "No status message";
    const lastActiveAgo = user.lastActiveAgo
      ? `${Math.floor(user.lastActiveAgo / 1000 / 60)} minutes ago`
      : "Unknown";

    // Get shared rooms
    const sharedRooms = client
      .getRooms()
      .filter((room) => room.getMember(targetUserId)?.membership === "join")
      .map((room) => room.name || room.roomId)
      .slice(0, 5); // Limit to first 5 shared rooms

    return {
      content: [
        {
          type: "text",
          text: `User Profile: ${targetUserId}
Display Name: ${displayName}
Avatar: ${avatarUrl}
Presence: ${presence}
Status: ${presenceStatus}
Last Active: ${lastActiveAgo}
Shared Rooms (up to 5): ${
            sharedRooms.length > 0 ? sharedRooms.join(", ") : "None visible"
          }`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to get user profile: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to get user profile - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Get my profile
export const getMyProfileHandler = async (_input: any, { requestInfo, authInfo }: any) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const user = client.getUser(matrixUserId);
    if (!user) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not retrieve your own profile information.`,
          },
        ],
        isError: true,
      };
    }

    const displayName = user.displayName || "No display name set";
    const avatarUrl = user.avatarUrl || "No avatar set";
    const presence = user.presence || "unknown";
    const presenceStatus = user.presenceStatusMsg || "No status message";

    // Get device information
    let deviceInfo = "Unable to retrieve device list";
    try {
      const devices = await client.getDevices();
      const currentDevice = devices.devices.find(
        (d) => d.device_id === client.getDeviceId()
      );
      deviceInfo = `Current device: ${
        currentDevice?.display_name || "Unknown"
      } (${client.getDeviceId()})
Total devices: ${devices.devices.length}`;
    } catch (error) {
      console.warn("Could not retrieve device information");
    }

    // Get room count
    const joinedRooms = client.getRooms();
    const roomCount = joinedRooms.length;
    const dmCount = joinedRooms.filter(
      (room) =>
        room.getMyMembership() === "join" && room.getJoinedMemberCount() === 2
    ).length;

    // E2EE health from diagnostic file (written by crypto bootstrap in client.ts)
    let e2eeStatus = "Not available";
    try {
      const dataDir = process.env.MATRIX_DATA_DIR ?? path.join(process.cwd(), ".data");
      const diagPath = path.join(dataDir, "e2ee-diagnostic.json");
      if (existsSync(diagPath)) {
        const diag = JSON.parse(readFileSync(diagPath, "utf-8"));
        if (diag.phase2Error) {
          e2eeStatus = `Error: ${diag.phase2Error}`;
        } else {
          const cs = diag.crossSigningStatus;
          const dv = diag.deviceVerificationStatus;
          e2eeStatus = `Device: ${diag.deviceId || "unknown"}` +
            `\n  Cross-signing keys on server: ${cs?.publicKeysOnDevice ?? "unknown"}` +
            `\n  Private keys cached locally: ${cs?.privateKeysCachedLocally?.masterKey ?? "unknown"}` +
            `\n  Device cross-signed: ${dv?.crossSigningVerified ?? "unknown"}`;
        }
      }
    } catch { /* diagnostic file unreadable — non-fatal */ }

    return {
      content: [
        {
          type: "text",
          text: `My Profile: ${matrixUserId}
Display Name: ${displayName}
Avatar: ${avatarUrl}
Presence: ${presence}
Status: ${presenceStatus}
Joined Rooms: ${roomCount}
Direct Messages: ${dmCount}
${deviceInfo}
E2EE Status: ${e2eeStatus}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to get my profile: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to get your profile - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Get all users
export const getAllUsersHandler = async (_input: any, { requestInfo, authInfo }: any) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const users = client.getUsers();
    return {
      content:
        users.length > 0
          ? users.map((user) => ({
              type: "text",
              text: `${user.displayName || user.userId} (${user.userId})`,
            }))
          : [
              {
                type: "text",
                text: "No users found in the client cache",
              },
            ],
    };
  } catch (error: any) {
    console.error(`Failed to get all users: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to get users - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Set display name
export const setDisplayNameHandler = async (
  { displayName }: { displayName: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const previousName = client.getUser(matrixUserId)?.displayName || "Not set";

    await client.setDisplayName(displayName);

    return {
      content: [
        {
          type: "text",
          text: `Successfully updated display name\nUser: ${matrixUserId}\nPrevious: ${previousName}\nNew: ${displayName}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to set display name: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to set display name - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

// Registration function
export const registerUserTools: ToolRegistrationFunction = (server) => {
  // Tool: Get user profile
  server.registerTool(
    "get-user-profile",
    {
      title: "Get Matrix User Profile",
      description: "Get profile information for a specific Matrix user including display name, avatar, presence, last active time, and up to 5 shared rooms",
      inputSchema: {
        targetUserId: z
          .string()
          .describe("Target user's Matrix ID to get profile for (e.g., @user:domain.com)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getUserProfileHandler
  );

  // Tool: Get my profile
  server.registerTool(
    "get-my-profile",
    {
      title: "Get My Matrix Profile",
      description: "Get your own profile information including display name, avatar, settings, device list, and E2EE encryption health status",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getMyProfileHandler
  );

  // Tool: Set display name
  server.registerTool(
    "set-display-name",
    {
      title: "Set Display Name",
      description: "Set your Matrix display name. This changes how your name appears to other users in rooms.",
      inputSchema: {
        displayName: z.string().describe("The new display name to set"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    setDisplayNameHandler
  );

  // Tool: Get all users
  server.registerTool(
    "get-all-users",
    {
      title: "Get All Known Users",
      description: "List all users known to the Matrix client from rooms you've joined (not all homeserver users). " +
        "Returns display names and user IDs. For a specific user's profile, use get-user-profile instead.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    getAllUsersHandler
  );
};