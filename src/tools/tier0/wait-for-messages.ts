import { z } from "zod";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export const registerWaitForMessagesTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "wait-for-messages",
    {
      title: "Wait for New Matrix Messages",
      description:
        "Wait for new incoming messages in real time, including direct messages. " +
        "Returns ONLY notification counts and room summary (not message content). " +
        "If messages are already queued, returns immediately. Otherwise blocks until " +
        "new messages arrive or timeout. Use get-queued-messages to retrieve actual content.",
      inputSchema: {
        roomId: z
          .string()
          .optional()
          .describe("Matrix room ID to watch. Omit to watch all joined rooms including DMs."),
        timeoutMs: z.coerce
          .number()
          .default(DEFAULT_TIMEOUT_MS)
          .describe("How long to wait in milliseconds (default 30 seconds, no upper limit)"),
        since: z
          .string()
          .optional()
          .describe("Deprecated — ignored. Continuation token management is now internal."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ timeoutMs }: { roomId?: string; timeoutMs: number; since?: string }) => {
      const queue = getMessageQueue();
      const timeout = Math.min(Math.max(timeoutMs, 1000), 2147483647);

      // Check if there are already queued items
      let peek = queue.peek();

      if (peek.count > 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "messages_available",
              count: peek.count,
              types: peek.types,
              rooms: peek.rooms,
            }),
          }],
        };
      }

      // No items — wait for new-item event or timeout
      const result = await new Promise<"new_items" | "timeout">((resolve) => {
        const onNewItem = () => {
          clearTimeout(timer);
          resolve("new_items");
        };

        const timer = setTimeout(() => {
          queue.removeListener("new-item", onNewItem);
          resolve("timeout");
        }, timeout);

        queue.once("new-item", onNewItem);
      });

      if (result === "timeout") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "timeout",
              count: 0,
              types: { messages: 0, reactions: 0, invites: 0 },
              rooms: [],
            }),
          }],
        };
      }

      // New items arrived — peek again for counts
      peek = queue.peek();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "messages_available",
            count: peek.count,
            types: peek.types,
            rooms: peek.rooms,
          }),
        }],
      };
    }
  );
};
