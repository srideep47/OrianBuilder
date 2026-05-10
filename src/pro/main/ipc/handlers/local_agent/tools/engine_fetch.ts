/**
 * Shared utility for making fetch requests to the OrianBuilder engine API.
 * Handles common headers including Authorization and X-OrianBuilder-Request-Id.
 */

import { readSettings } from "@/main/settings";
import type { AgentContext } from "./types";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

export const ORIANBUILDER_ENGINE_URL =
  process.env.ORIANBUILDER_ENGINE_URL ?? "https://engine.orianbuilder.sh/v1";

export interface EngineFetchOptions extends Omit<RequestInit, "headers"> {
  /** Additional headers to include */
  headers?: Record<string, string>;
}

/**
 * Fetch wrapper for OrianBuilder engine API calls.
 * Automatically adds Authorization and X-OrianBuilder-Request-Id headers.
 *
 * @param ctx - The agent context containing the request ID
 * @param endpoint - The API endpoint path (e.g., "/tools/web-search")
 * @param options - Fetch options (method, body, additional headers, etc.)
 * @returns The fetch Response
 * @throws Error if OrianBuilder Pro API key is not configured
 */
export async function engineFetch(
  ctx: Pick<AgentContext, "orianbuilderRequestId">,
  endpoint: string,
  options: EngineFetchOptions = {},
): Promise<Response> {
  const settings = readSettings();
  const apiKey = settings.providerSettings?.auto?.apiKey?.value;

  if (!apiKey) {
    throw new OrianBuilderError(
      "OrianBuilder Pro API key is required",
      OrianBuilderErrorKind.Auth,
    );
  }

  const { headers: extraHeaders, ...restOptions } = options;

  return fetch(`${ORIANBUILDER_ENGINE_URL}${endpoint}`, {
    ...restOptions,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-OrianBuilder-Request-Id": ctx.orianbuilderRequestId,
      ...extraHeaders,
    },
  });
}
