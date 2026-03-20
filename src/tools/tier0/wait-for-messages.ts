import { z } from "zod";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000; // 5 minutes — hard cap prevents zombie listeners

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
          .describe(`How long to wait in milliseconds (default ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s)`),
        since: z
          .string()
          .optional()
          .describe("Deprecated — ignored. Continuation token management is now internal."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (
      { roomId, timeoutMs }: { roomId?: string; timeoutMs: number; since?: string },
      extra: { signal?: AbortSignal }
    ) => {
      const queue = getMessageQueue();
      const timeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
      const signal = extra?.signal;

      // If already aborted, return immediately
      if (signal?.aborted) {
        return formatResponse("aborted", roomId ? queue.peekRoom(roomId) : queue.peek());
      }

      // Check if there are already queued items (room-filtered if specified)
      let peek = roomId ? queue.peekRoom(roomId) : queue.peek();

      if (peek.count > 0) {
        return formatResponse("messages_available", peek);
      }

      // No items — wait for new-item event, timeout, or abort
      const result = await new Promise<"new_items" | "timeout" | "aborted">((resolve) => {
        let resolved = false;
        const done = (value: "new_items" | "timeout" | "aborted") => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          queue.removeListener("new-item", onNewItem);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };

        const onNewItem = (evt: { roomId?: string }) => {
          // If watching a specific room, ignore events for other rooms
          if (roomId && evt.roomId !== roomId) return;
          done("new_items");
        };

        const onAbort = () => done("aborted");

        const timer = setTimeout(() => done("timeout"), timeout);

        queue.on("new-item", onNewItem);
        signal?.addEventListener("abort", onAbort, { once: true });
      });

      if (result === "timeout") {
        return formatResponse("timeout", { count: 0, types: { messages: 0, reactions: 0, invites: 0 }, rooms: [] });
      }

      if (result === "aborted") {
        return formatResponse("aborted", roomId ? queue.peekRoom(roomId) : queue.peek());
      }

      // New items arrived — peek again for counts
      peek = roomId ? queue.peekRoom(roomId) : queue.peek();
      return formatResponse("messages_available", peek);
    }
  );
};

function formatResponse(
  status: string,
  peek: { count: number; types: { messages: number; reactions: number; invites: number }; rooms: any[] }
) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        status,
        count: peek.count,
        types: peek.types,
        rooms: peek.rooms,
      }),
    }],
  };
}
