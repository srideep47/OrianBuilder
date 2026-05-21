/**
 * RemotePeerProvider — routes inference through the local compute proxy (port 11436)
 * which tunnels requests to the selected remote peer over the Noise P2P channel.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { localModelFetch } from "@/ipc/utils/local_model_fetch";
import { PROXY_PORT } from "@/main/compute/compute-proxy";
import type { ModelProvider } from "./types";

export const remotePeerProvider: ModelProvider = {
  id: "remote-peer",
  supportsStreaming: true,
  supportsTools: false,
  createClient({ model, providerId }) {
    const provider = createOpenAICompatible({
      name: "remote-peer",
      baseURL: `http://127.0.0.1:${PROXY_PORT}/v1`,
      fetch: localModelFetch,
    });
    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};
