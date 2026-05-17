import { db } from "../../db";
import { mcpServers, mcpToolConsents } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { IpcMainInvokeEvent } from "electron";
import crypto from "node:crypto";
import { buildMcpToolKey, sanitizeMcpName } from "./mcp_tool_utils";
import type { McpToolTrustOverrideMap } from "./mcp_tool_capabilities";

export type Consent = "ask" | "always" | "denied";

const pendingConsentResolvers = new Map<
  string,
  (d: "accept-once" | "accept-always" | "decline") => void
>();

export function waitForConsent(
  requestId: string,
): Promise<"accept-once" | "accept-always" | "decline"> {
  return new Promise((resolve) => {
    pendingConsentResolvers.set(requestId, resolve);
  });
}

export function resolveConsent(
  requestId: string,
  decision: "accept-once" | "accept-always" | "decline",
) {
  const resolver = pendingConsentResolvers.get(requestId);
  if (resolver) {
    pendingConsentResolvers.delete(requestId);
    resolver(decision);
  }
}

export async function getStoredConsent(
  serverId: number,
  toolName: string,
): Promise<Consent> {
  const rows = await db
    .select()
    .from(mcpToolConsents)
    .where(
      and(
        eq(mcpToolConsents.serverId, serverId),
        eq(mcpToolConsents.toolName, toolName),
      ),
    );
  if (rows.length === 0) return "ask";
  return (rows[0].consent as Consent) ?? "ask";
}

export async function setStoredConsent(
  serverId: number,
  toolName: string,
  consent: Consent,
): Promise<void> {
  const rows = await db
    .select()
    .from(mcpToolConsents)
    .where(
      and(
        eq(mcpToolConsents.serverId, serverId),
        eq(mcpToolConsents.toolName, toolName),
      ),
    );
  if (rows.length > 0) {
    await db
      .update(mcpToolConsents)
      .set({ consent })
      .where(
        and(
          eq(mcpToolConsents.serverId, serverId),
          eq(mcpToolConsents.toolName, toolName),
        ),
      );
  } else {
    await db.insert(mcpToolConsents).values({ serverId, toolName, consent });
  }
}

export async function getMcpToolTrustOverridesByToolKey(): Promise<McpToolTrustOverrideMap> {
  const rows = await db
    .select({
      serverName: mcpServers.name,
      toolName: mcpToolConsents.toolName,
      riskOverride: mcpToolConsents.riskOverride,
      stateScopeOverride: mcpToolConsents.stateScopeOverride,
      requiresExplicitConsentOverride:
        mcpToolConsents.requiresExplicitConsentOverride,
    })
    .from(mcpToolConsents)
    .innerJoin(mcpServers, eq(mcpToolConsents.serverId, mcpServers.id));

  const overrides: McpToolTrustOverrideMap = {};
  for (const row of rows) {
    if (
      row.riskOverride == null &&
      row.stateScopeOverride == null &&
      row.requiresExplicitConsentOverride == null
    ) {
      continue;
    }

    overrides[
      buildMcpToolKey(
        sanitizeMcpName(row.serverName),
        sanitizeMcpName(row.toolName),
      )
    ] = {
      risk: row.riskOverride as McpToolTrustOverrideMap[string]["risk"],
      stateScope:
        row.stateScopeOverride as McpToolTrustOverrideMap[string]["stateScope"],
      requiresExplicitConsent: row.requiresExplicitConsentOverride,
    };
  }
  return overrides;
}

export async function requireMcpToolConsent(
  event: IpcMainInvokeEvent,
  params: {
    serverId: number;
    serverName: string;
    toolName: string;
    toolDescription?: string | null;
    inputPreview?: string | null;
  },
): Promise<boolean> {
  const current = await getStoredConsent(params.serverId, params.toolName);
  if (current === "always") return true;
  if (current === "denied") return false;

  // Ask renderer for a decision via event bridge
  const requestId = `${params.serverId}:${params.toolName}:${crypto.randomUUID()}`;
  (event.sender as any).send("mcp:tool-consent-request", {
    requestId,
    ...params,
  });
  const response = await waitForConsent(requestId);

  if (response === "accept-always") {
    await setStoredConsent(params.serverId, params.toolName, "always");
    return true;
  }
  if (response === "decline") {
    return false;
  }
  return response === "accept-once";
}
