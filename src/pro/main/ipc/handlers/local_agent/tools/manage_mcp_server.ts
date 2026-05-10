import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const manageMcpServerSchema = z.object({
  action: z
    .enum(["list", "connect", "disconnect", "reload"])
    .describe("MCP runtime action to perform."),
  server_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required for connect, disconnect, and reload."),
});

type ManageMcpServerArgs = z.infer<typeof manageMcpServerSchema>;

export const manageMcpServerTool: ToolDefinition<ManageMcpServerArgs> = {
  name: "manage_mcp_server",
  description: `List, connect, disconnect, or reload configured MCP servers through Orian's shared MCP runtime.

Use list before relying on external MCP tools. Use reload after a server configuration changes or when a cached MCP connection appears stale. This tool only manages servers already configured in Settings; it does not create new arbitrary stdio commands.`,
  inputSchema: manageMcpServerSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    args.action === "list"
      ? "List configured MCP servers"
      : `${args.action} MCP server ${args.server_id ?? "(missing server id)"}`,

  buildXml: (args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-mcp-runtime action="${escapeXmlAttr(args.action ?? "")}" server-id="${args.server_id ?? ""}">Managing MCP runtime...`;
  },

  execute: async (args, ctx: AgentContext) => {
    if (args.action === "list") {
      const servers = await listServers();
      ctx.onXmlComplete(
        `<orianbuilder-mcp-runtime action="list">${escapeXmlContent(JSON.stringify(servers, null, 2))}</orianbuilder-mcp-runtime>`,
      );
      return JSON.stringify(servers, null, 2);
    }

    if (!args.server_id) {
      throw new Error(`server_id is required for ${args.action}.`);
    }

    const server = await getServer(args.server_id);
    if (!server) {
      throw new Error(`MCP server not found: ${args.server_id}`);
    }

    if (args.action === "disconnect") {
      mcpManager.dispose(args.server_id);
    } else if (args.action === "reload") {
      await mcpManager.reload(args.server_id);
    } else {
      await mcpManager.getClient(args.server_id);
    }

    const result = {
      id: server.id,
      name: server.name,
      action: args.action,
      connected: mcpManager.isConnected(server.id),
    };
    ctx.onXmlComplete(
      `<orianbuilder-mcp-runtime action="${escapeXmlAttr(args.action)}" server-id="${server.id}" connected="${result.connected ? "true" : "false"}">${escapeXmlContent(JSON.stringify(result, null, 2))}</orianbuilder-mcp-runtime>`,
    );
    return JSON.stringify(result, null, 2);
  },
};

async function listServers() {
  const connectedServerIds = new Set(mcpManager.listConnectedServerIds());
  const connectionStates = new Map(
    mcpManager.listConnectionStates().map((state) => [state.serverId, state]),
  );
  const servers = await db.select().from(mcpServers);
  return servers.map((server) => ({
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    connected: connectedServerIds.has(server.id),
    refCount: connectionStates.get(server.id)?.refCount ?? 0,
    sessionIds: connectionStates.get(server.id)?.sessionIds ?? [],
    lastUsedAt: connectionStates.get(server.id)?.lastUsedAt ?? null,
  }));
}

async function getServer(serverId: number) {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  return server;
}
