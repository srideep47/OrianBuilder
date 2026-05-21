import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const GoogleUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  avatar: z.string(),
});
export type GoogleUser = z.infer<typeof GoogleUserSchema>;

export const AuthStatusSchema = z.object({
  isSignedIn: z.boolean(),
  hasCredentials: z.boolean(),
  user: GoogleUserSchema.nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const SetGoogleCredentialsInputSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
});
export type SetGoogleCredentialsInput = z.infer<
  typeof SetGoogleCredentialsInputSchema
>;

// =============================================================================
// Contracts
// =============================================================================

export const orionAuthContracts = {
  getStatus: defineContract({
    channel: "orion-auth:get-status",
    input: z.void(),
    output: AuthStatusSchema,
  }),

  signIn: defineContract({
    channel: "orion-auth:sign-in",
    input: z.void(),
    output: GoogleUserSchema,
  }),

  signOut: defineContract({
    channel: "orion-auth:sign-out",
    input: z.void(),
    output: z.object({ success: z.boolean() }),
  }),

  setCredentials: defineContract({
    channel: "orion-auth:set-credentials",
    input: SetGoogleCredentialsInputSchema,
    output: z.object({ success: z.boolean() }),
  }),
} as const;

export const orionAuthClient = createClient(orionAuthContracts);
