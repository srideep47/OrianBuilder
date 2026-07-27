import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  ORION_BRIDGE_PORT,
  ORION_BRIDGE_TOKEN_FILE,
  type BridgeAction,
} from "./bridge_source";

const logger = log.scope("godot-bridge");

export interface BridgeResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** Transport failure — distinct from a well-formed `{ok:false}` op failure. */
export class BridgeUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnreachableError";
  }
}

/**
 * Where Godot's `user://` maps to on disk, which is where the bridge writes its
 * token. Godot derives this from the project's `application/config/name`, but a
 * project run with `--path` and no custom `user_dir` uses the app-name folder
 * under the platform data dir. Rather than reimplement that derivation (and get
 * it wrong for renamed projects), we let the launcher pass `--write-movie`-style
 * explicit paths: `process.ts` always starts Godot with
 * `--userdir`-equivalent behaviour by setting the project's `user://` root to a
 * known folder inside the Orion project, so the token is simply
 * `<project>/.orion/godot-user/orion_bridge_token.txt`.
 */
export function tokenPathForProject(projectDir: string): string {
  return path.join(projectDir, ".orion", "godot-user", ORION_BRIDGE_TOKEN_FILE);
}

async function readToken(projectDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(tokenPathForProject(projectDir), "utf8");
    const token = raw.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * One request/response over the bridge.
 *
 * A fresh connection per request rather than a long-lived socket, matching
 * Android's client: the bridge accepts one request per frame per connection, so
 * pooling buys nothing, and a per-call socket means a hung engine frame can
 * never wedge a shared connection for every subsequent call.
 */
async function request(
  projectDir: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<BridgeResponse> {
  const token = await readToken(projectDir);
  if (!token) {
    throw new BridgeUnreachableError(
      "Godot bridge token not found — the engine has not started, or it started without the Orion bridge installed.",
    );
  }

  return new Promise<BridgeResponse>((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () =>
      finish(() =>
        reject(
          new BridgeUnreachableError(
            `Godot bridge did not answer within ${timeoutMs} ms`,
          ),
        ),
      ),
    );
    socket.on("error", (err) =>
      finish(() => reject(new BridgeUnreachableError(err.message))),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line) as BridgeResponse);
        } catch (err) {
          reject(
            new BridgeUnreachableError(
              `Godot bridge returned malformed JSON: ${(err as Error).message}`,
            ),
          );
        }
      });
    });
    socket.on("close", () =>
      finish(() =>
        reject(
          new BridgeUnreachableError("Godot bridge closed the connection"),
        ),
      ),
    );

    socket.connect(ORION_BRIDGE_PORT, "127.0.0.1", () => {
      socket.write(`${JSON.stringify({ ...body, token })}\n`);
    });
  });
}

/**
 * Typed client for the live engine.
 *
 * Speaks the same NDJSON-over-loopback protocol as OrionAndroid's
 * `GodotController`, so a scene inspected on either client returns identical
 * JSON. Ops return the *raw* response including `error`, because every caller
 * is either surfacing it to an LLM verbatim or rendering it in the inspector —
 * unwrapping to a nullable would throw away the one thing that makes a failure
 * actionable.
 */
export class GodotBridgeClient {
  constructor(private readonly projectDir: string) {}

  /** Generic call. `timeoutMs` is generous for screenshots, tight for polls. */
  async call(
    action: BridgeAction | string,
    params: Record<string, unknown> = {},
    timeoutMs = 8_000,
  ): Promise<BridgeResponse> {
    return request(this.projectDir, { action, ...params }, timeoutMs);
  }

  /** Cheap liveness check used by the status poller. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.call("ping", {}, 2_000);
      return res.ok === true;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<BridgeResponse> {
    return this.call("capabilities", {}, 4_000);
  }

  async sceneTree(nodePath?: string, depth = 8): Promise<BridgeResponse> {
    return this.call("scene_tree", { path: nodePath ?? "", depth }, 10_000);
  }

  async perfSnapshot(): Promise<BridgeResponse> {
    return this.call("perf_snapshot", {}, 4_000);
  }

  /** Writes a PNG and returns its absolute host path in `path`. */
  async screenshot(targetResPath?: string): Promise<BridgeResponse> {
    return this.call("screenshot", { path: targetResPath ?? "" }, 20_000);
  }

  async listProperties(nodePath: string): Promise<BridgeResponse> {
    return this.call("list_properties", { path: nodePath }, 10_000);
  }

  async listMethods(nodePath: string): Promise<BridgeResponse> {
    return this.call("list_methods", { path: nodePath }, 10_000);
  }

  async getProperty(
    nodePath: string,
    property: string,
  ): Promise<BridgeResponse> {
    return this.call("get_property", { path: nodePath, property });
  }

  async setProperty(
    nodePath: string,
    property: string,
    value: unknown,
  ): Promise<BridgeResponse> {
    return this.call("set_property", { path: nodePath, property, value });
  }

  async callMethod(
    nodePath: string,
    method: string,
    args: unknown[] = [],
  ): Promise<BridgeResponse> {
    return this.call("call_method", { path: nodePath, method, args }, 30_000);
  }

  async createNode(params: {
    parent: string;
    class: string;
    name?: string;
    properties?: Record<string, unknown>;
  }): Promise<BridgeResponse> {
    return this.call("create_node", params);
  }

  async deleteNode(nodePath: string): Promise<BridgeResponse> {
    return this.call("delete_node", { path: nodePath });
  }

  async reparentNode(
    nodePath: string,
    parent: string,
    keepTransform = true,
  ): Promise<BridgeResponse> {
    return this.call("reparent_node", {
      path: nodePath,
      parent,
      keep_transform: keepTransform,
    });
  }

  async setPaused(paused: boolean): Promise<BridgeResponse> {
    return this.call("set_paused", { paused });
  }

  async step(frames = 1): Promise<BridgeResponse> {
    return this.call("step", { frames });
  }

  async simulateInput(
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    return this.call("simulate_input", params);
  }

  async inputActions(): Promise<BridgeResponse> {
    return this.call("input_actions");
  }

  async reloadScript(
    script: string,
    nodePath?: string,
  ): Promise<BridgeResponse> {
    return this.call("reload_script", { script, path: nodePath ?? "" });
  }

  async saveScene(resPath?: string): Promise<BridgeResponse> {
    return this.call("save_scene", { path: resPath ?? "" }, 30_000);
  }

  async changeScene(resPath: string): Promise<BridgeResponse> {
    return this.call("change_scene", { path: resPath }, 20_000);
  }

  async projectSetting(key: string, value?: unknown): Promise<BridgeResponse> {
    return value === undefined
      ? this.call("project_setting", { key })
      : this.call("project_setting", { key, value });
  }

  async classDb(params: {
    class?: string;
    filter?: string;
  }): Promise<BridgeResponse> {
    return this.call("classdb", params, 15_000);
  }

  /**
   * Waits for the bridge to come up after a launch. Returns false on timeout
   * rather than throwing, so callers can report "engine started but the bridge
   * never answered" as its own distinct state.
   */
  async waitUntilReady(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.ping()) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    logger.warn(`Bridge never answered within ${timeoutMs} ms`);
    return false;
  }
}
