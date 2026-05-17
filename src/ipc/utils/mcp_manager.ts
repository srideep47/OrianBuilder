import { db } from "../../db";
import { mcpServers } from "../../db/schema";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { eq } from "drizzle-orm";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

type McpClientEntry = {
  client: MCPClient;
  configHash: string;
  refCount: number;
  sessionIds: Set<string>;
  connectedAt: Date;
  lastUsedAt: Date;
};

const MCP_RECONNECT_COOLDOWN_MS = 2_000;

class McpManager {
  private static _instance: McpManager;
  static get instance(): McpManager {
    if (!this._instance) this._instance = new McpManager();
    return this._instance;
  }

  private clients = new Map<number, McpClientEntry>();
  private reconnectCooldownUntil = new Map<number, number>();

  listConnectedServerIds() {
    return [...this.clients.keys()];
  }

  listConnectionStates() {
    return [...this.clients.entries()].map(([serverId, entry]) => ({
      serverId,
      connected: true,
      refCount: entry.refCount,
      sessionIds: [...entry.sessionIds],
      configHash: entry.configHash,
      connectedAt: entry.connectedAt,
      lastUsedAt: entry.lastUsedAt,
    }));
  }

  isConnected(serverId: number) {
    return this.clients.has(serverId);
  }

  async getClient(serverId: number, sessionId?: string): Promise<MCPClient> {
    return this.acquireClient(serverId, sessionId);
  }

  async acquireClient(
    serverId: number,
    sessionId?: string,
  ): Promise<MCPClient> {
    const existing = this.clients.get(serverId);
    const server = await getMcpServerOrThrow(serverId);
    const configHash = getMcpServerConfigHash(server);
    if (existing && existing.configHash === configHash) {
      existing.lastUsedAt = new Date();
      if (sessionId && !existing.sessionIds.has(sessionId)) {
        existing.sessionIds.add(sessionId);
        existing.refCount += 1;
      }
      return existing.client;
    }
    if (existing) {
      this.dispose(serverId, { force: true });
    }

    const cooldownUntil = this.reconnectCooldownUntil.get(serverId) ?? 0;
    const now = Date.now();
    if (cooldownUntil > now) {
      throw new OrianBuilderError(
        `MCP server ${serverId} is cooling down before reconnect for ${cooldownUntil - now}ms.`,
        OrianBuilderErrorKind.RateLimited,
      );
    }

    const client = await this.createClient(server);
    this.clients.set(serverId, {
      client,
      configHash,
      refCount: sessionId ? 1 : 0,
      sessionIds: new Set(sessionId ? [sessionId] : []),
      connectedAt: new Date(),
      lastUsedAt: new Date(),
    });
    return client;
  }

  releaseClient(serverId: number, sessionId?: string) {
    const entry = this.clients.get(serverId);
    if (!entry || !sessionId || !entry.sessionIds.has(sessionId)) {
      return;
    }

    entry.sessionIds.delete(sessionId);
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = new Date();
  }

  private async createClient(
    s: typeof mcpServers.$inferSelect,
  ): Promise<MCPClient> {
    const server = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, s.id));
    if (!server.find((x) => x.id === s.id)) {
      throw new Error(`MCP server not found: ${s.id}`);
    }
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (s.transport === "stdio") {
      const args = s.args ?? [];
      const env = s.envJson ?? undefined;
      if (!s.command) throw new Error("MCP server command is required");
      transport = new StdioClientTransport({
        command: s.command,
        args,
        env,
      });
    } else if (s.transport === "http") {
      if (!s.url) throw new Error("HTTP MCP requires url");
      const headers = s.headersJson ?? {};
      transport = new StreamableHTTPClientTransport(new URL(s.url as string), {
        requestInit: {
          headers,
        },
      });
    } else {
      throw new OrianBuilderError(
        `Unsupported MCP transport: ${s.transport}`,
        OrianBuilderErrorKind.Validation,
      );
    }
    return createMCPClient({
      transport,
    });
  }

  dispose(serverId: number, options?: { force?: boolean }) {
    const entry = this.clients.get(serverId);
    if (entry) {
      if (!options?.force && entry.refCount > 0) {
        return false;
      }
      entry.client.close();
      this.clients.delete(serverId);
      this.reconnectCooldownUntil.set(
        serverId,
        Date.now() + MCP_RECONNECT_COOLDOWN_MS,
      );
    }
    return true;
  }

  async reload(serverId: number): Promise<MCPClient> {
    this.dispose(serverId, { force: true });
    this.reconnectCooldownUntil.delete(serverId);
    return this.getClient(serverId);
  }

  releaseSession(sessionId: string) {
    for (const [serverId, entry] of this.clients) {
      if (!entry.sessionIds.has(sessionId)) continue;
      entry.sessionIds.delete(sessionId);
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = new Date();
      if (entry.refCount === 0) {
        this.dispose(serverId);
      }
    }
  }
}

export const mcpManager = McpManager.instance;

async function getMcpServerOrThrow(serverId: number) {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!server) {
    throw new Error(`MCP server not found: ${serverId}`);
  }
  return server;
}

function getMcpServerConfigHash(server: typeof mcpServers.$inferSelect) {
  return JSON.stringify({
    transport: server.transport,
    command: server.command,
    args: server.args ?? null,
    envJson: server.envJson ?? null,
    headersJson: server.headersJson ?? null,
    url: server.url,
    enabled: server.enabled,
  });
}
