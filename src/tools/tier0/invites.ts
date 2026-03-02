import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

export const registerInviteTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "get-pending-invites",
    {
      title: "Get Pending Room Invites",
      description:
        "List all Matrix rooms you have been invited to but not yet joined. " +
        "Returns room ID, name, and who sent the invite. " +
        "Use join-room to accept an invite.",
      inputSchema: {},
    },
    async (_input: any, { requestInfo, authInfo }: any) => {
      const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
      const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

      try {
        const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
        const invites = client.getRooms().filter((r) => r.getMyMembership() === "invite");

        if (invites.length === 0) {
          return { content: [{ type: "text" as const, text: "No pending invites." }] };
        }

        return {
          content: invites.map((room: any) => {
            const member = room.currentState.getMember(matrixUserId);
            const invitedBy = member?.events?.member?.getSender() ?? "unknown";
            return {
              type: "text" as const,
              text: JSON.stringify({
                roomId: room.roomId,
                roomName: room.name || room.roomId,
                invitedBy,
              }),
            };
          }),
        };
      } catch (error: any) {
        console.error(`Failed to get pending invites: ${error.message}`);
        removeClientFromCache(matrixUserId, homeserverUrl);
        return {
          content: [{ type: "text" as const, text: `Error: Failed to get pending invites - ${error.message}` }],
          isError: true,
        };
      }
    }
  );
};
