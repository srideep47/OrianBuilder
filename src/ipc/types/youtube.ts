import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

export const YouTubePrivacySchema = z.enum(["public", "unlisted", "private"]);
export type YouTubePrivacy = z.infer<typeof YouTubePrivacySchema>;

export const YouTubeStatusSchema = z.object({
  hasCredentials: z.boolean(),
  connected: z.boolean(),
  channelTitle: z.string().nullable(),
});
export type YouTubeStatus = z.infer<typeof YouTubeStatusSchema>;

export const youtubeContracts = {
  getStatus: defineContract({
    channel: "youtube:get-status",
    input: z.void(),
    output: YouTubeStatusSchema,
  }),
  /** Save the user's BYO Google OAuth Desktop-app client credentials. */
  saveCredentials: defineContract({
    channel: "youtube:save-credentials",
    input: z.object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
    }),
    output: YouTubeStatusSchema,
  }),
  /** Run the interactive loopback OAuth flow to connect a channel. */
  connect: defineContract({
    channel: "youtube:connect",
    input: z.void(),
    output: YouTubeStatusSchema,
  }),
  /** Disconnect and wipe stored credentials + tokens. */
  disconnect: defineContract({
    channel: "youtube:disconnect",
    input: z.void(),
    output: YouTubeStatusSchema,
  }),
  /** Upload a generated-media video to the connected channel. */
  publish: defineContract({
    channel: "youtube:publish",
    input: z.object({
      fileName: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      privacy: YouTubePrivacySchema,
      tags: z.array(z.string()).optional(),
    }),
    output: z.object({
      videoId: z.string(),
      url: z.string(),
    }),
  }),
} as const;

export const youtubeClient = createClient(youtubeContracts);

export const youtubeEvents = {
  publishProgress: defineEvent({
    channel: "youtube:publish-progress",
    payload: z.object({
      fileName: z.string(),
      percent: z.number(),
    }),
  }),
} as const;

export const youtubeEventClient = createEventClient(youtubeEvents);
