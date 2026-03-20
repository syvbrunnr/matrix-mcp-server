import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { getMetrics } from "../../matrix/pipelineMetrics.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

export const registerServerAdminTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "restart-server",
    {
      title: "Restart MCP Server",
      description:
        "Gracefully restart the Matrix MCP server to pick up code changes. " +
        "The process exits cleanly; Claude Code restarts the subprocess automatically. " +
        "Use after modifying source files to reload the new code.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      // Send response first, then exit after a short delay
      setTimeout(() => process.exit(0), 200);
      return {
        content: [
          {
            type: "text" as const,
            text: "Restarting Matrix MCP server — Claude Code will reconnect automatically.",
          },
        ],
      };
    }
  );

  server.registerTool(
    "get-pipeline-metrics",
    {
      title: "Event Pipeline Metrics",
      description:
        "Diagnostic tool: returns counters for the event pipeline (autoSync → messageQueue → notifications). " +
        "Shows events received, enqueued, filtered, deduplicated, and errors since last restart. " +
        "Use to diagnose message loss or verify the pipeline is healthy.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const metrics = getMetrics();
      const queue = getMessageQueue().peek();
      const uptime = metrics.firstEventAt
        ? Math.round((Date.now() - metrics.firstEventAt) / 1000)
        : 0;

      const lines = [
        `Pipeline Metrics (uptime: ${uptime}s)`,
        `  Events received:      ${metrics.eventsReceived}`,
        `  Messages enqueued:    ${metrics.messagesEnqueued}`,
        `  Messages filtered:    ${metrics.messagesFiltered}`,
        `  Messages deduplicated:${metrics.messagesDeduplicated}`,
        `  Reactions enqueued:   ${metrics.reactionsEnqueued}`,
        `  Edits processed:     ${metrics.editsProcessed}`,
        `  Listener errors:     ${metrics.listenerErrors}`,
        ``,
        `Queue state:`,
        `  Pending messages:    ${queue.types.messages}`,
        `  Pending reactions:   ${queue.types.reactions}`,
        `  Pending invites:     ${queue.types.invites}`,
      ];

      if (metrics.lastEventAt) {
        const ago = Math.round((Date.now() - metrics.lastEventAt) / 1000);
        lines.push(`  Last event:          ${ago}s ago`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
};
