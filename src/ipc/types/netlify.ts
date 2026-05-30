import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Netlify Schemas
// =============================================================================

export const NetlifySiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  framework: z.string().nullable().optional(),
});

export type NetlifySite = z.infer<typeof NetlifySiteSchema>;

export const NetlifyDeploymentSchema = z.object({
  uid: z.string(),
  url: z.string(),
  state: z.string(),
  createdAt: z.number(),
  target: z.string(),
  readyState: z.string(),
});

export type NetlifyDeployment = z.infer<typeof NetlifyDeploymentSchema>;

export const SaveNetlifyAccessTokenParamsSchema = z.object({
  token: z.string(),
});

export type SaveNetlifyAccessTokenParams = z.infer<
  typeof SaveNetlifyAccessTokenParamsSchema
>;

export const ConnectToExistingNetlifySiteParamsSchema = z.object({
  appId: z.number(),
  siteId: z.string(),
});

export type ConnectToExistingNetlifySiteParams = z.infer<
  typeof ConnectToExistingNetlifySiteParamsSchema
>;

export const IsNetlifySiteAvailableParamsSchema = z.object({
  name: z.string(),
});

export type IsNetlifySiteAvailableParams = z.infer<
  typeof IsNetlifySiteAvailableParamsSchema
>;

export const IsNetlifySiteAvailableResponseSchema = z.object({
  available: z.boolean(),
  error: z.string().optional(),
});

export type IsNetlifySiteAvailableResponse = z.infer<
  typeof IsNetlifySiteAvailableResponseSchema
>;

export const CreateNetlifySiteParamsSchema = z.object({
  name: z.string(),
  appId: z.number(),
});

export type CreateNetlifySiteParams = z.infer<
  typeof CreateNetlifySiteParamsSchema
>;

export const GetNetlifyDeploymentsParamsSchema = z.object({
  appId: z.number(),
});

export type GetNetlifyDeploymentsParams = z.infer<
  typeof GetNetlifyDeploymentsParamsSchema
>;

export const DisconnectNetlifySiteParamsSchema = z.object({
  appId: z.number(),
});

export type DisconnectNetlifySiteParams = z.infer<
  typeof DisconnectNetlifySiteParamsSchema
>;

// =============================================================================
// Netlify Contracts
// =============================================================================

export const netlifyContracts = {
  saveToken: defineContract({
    channel: "netlify:save-token",
    input: SaveNetlifyAccessTokenParamsSchema,
    output: z.void(),
  }),

  listSites: defineContract({
    channel: "netlify:list-sites",
    input: z.void(),
    output: z.array(NetlifySiteSchema),
  }),

  isSiteAvailable: defineContract({
    channel: "netlify:is-site-available",
    input: IsNetlifySiteAvailableParamsSchema,
    output: IsNetlifySiteAvailableResponseSchema,
  }),

  createSite: defineContract({
    channel: "netlify:create-site",
    input: CreateNetlifySiteParamsSchema,
    output: z.void(),
  }),

  connectExistingSite: defineContract({
    channel: "netlify:connect-existing-site",
    input: ConnectToExistingNetlifySiteParamsSchema,
    output: z.void(),
  }),

  getDeployments: defineContract({
    channel: "netlify:get-deployments",
    input: GetNetlifyDeploymentsParamsSchema,
    output: z.array(NetlifyDeploymentSchema),
  }),

  disconnect: defineContract({
    channel: "netlify:disconnect",
    input: DisconnectNetlifySiteParamsSchema,
    output: z.void(),
  }),
} as const;

// =============================================================================
// Netlify Client
// =============================================================================

export const netlifyClient = createClient(netlifyContracts);
