import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { getMetrics } from "../../matrix/pipelineMetrics.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";
import { isAutoSyncRunning, getAutoSyncState } from "../../matrix/autoSync.js";
import { getPhase2Status } from "../../matrix/e2eeStatus.js";
import { getCacheStats } from "../../matrix/clientCache.js";
import { getMatrixContext } from "../../utils/server-helpers.js";

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

  server.registerTool(
    "get-server-health",
    {
      title: "Server Health & Diagnostics",
      description:
        "Comprehensive health check: sync state, E2EE bootstrap status, queue depth, " +
        "client cache, pipeline stats, and process info. Use when encountering [encrypted] " +
        "messages, missing notifications, or other systemic issues to diagnose root cause.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      // Sync state
      const syncRunning = isAutoSyncRunning();
      const syncState = getAutoSyncState();

      // E2EE status
      let e2ee: Record<string, any> | undefined;
      try {
        const { matrixUserId, homeserverUrl } = getMatrixContext(undefined);
        const phase2 = getPhase2Status(matrixUserId, homeserverUrl);
        e2ee = {
          userId: matrixUserId,
          phase2State: phase2?.state ?? "not_started",
          ...(phase2?.error ? { error: phase2.error } : {}),
          ...(phase2?.retryCount ? { retryCount: phase2.retryCount } : {}),
          ...(phase2?.startedAt ? { startedAt: new Date(phase2.startedAt).toISOString() } : {}),
          ...(phase2?.completedAt ? { completedAt: new Date(phase2.completedAt).toISOString() } : {}),
        };
      } catch {
        e2ee = { error: "Matrix context not configured" };
      }

      // Queue state
      const queue = getMessageQueue().peek();

      // Pipeline metrics
      const metrics = getMetrics();
      const pipelineUptime = metrics.firstEventAt
        ? Math.round((Date.now() - metrics.firstEventAt) / 1000)
        : 0;

      // Client cache
      const cache = getCacheStats();

      // Process info
      const mem = process.memoryUsage();

      const health = {
        status: syncRunning && syncState === "SYNCING" ? "healthy" : "degraded",
        sync: {
          running: syncRunning,
          state: syncState ?? "not_started",
        },
        e2ee,
        queue: {
          pending: queue.count,
          messages: queue.types.messages,
          reactions: queue.types.reactions,
          invites: queue.types.invites,
        },
        pipeline: {
          uptimeSeconds: pipelineUptime,
          eventsReceived: metrics.eventsReceived,
          messagesEnqueued: metrics.messagesEnqueued,
          listenerErrors: metrics.listenerErrors,
          lastEventSecondsAgo: metrics.lastEventAt
            ? Math.round((Date.now() - metrics.lastEventAt) / 1000)
            : null,
        },
        clientCache: {
          activeClients: cache.size,
        },
        process: {
          uptimeSeconds: Math.round(process.uptime()),
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }],
      };
    }
  );
};
