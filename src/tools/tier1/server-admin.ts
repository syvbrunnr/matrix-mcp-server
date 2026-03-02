import { ToolRegistrationFunction } from "../../types/tool-types.js";

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
};
