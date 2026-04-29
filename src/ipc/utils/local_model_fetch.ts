import http from "node:http";
import https from "node:https";

// Local models (LM Studio, Ollama) can be slow to respond — a 27B model
// generating a full codebase easily exceeds the 300 s body timeout of
// Electron's built-in fetch (undici). node:http/https have NO default
// timeout, so we build a minimal fetch-compatible wrapper around them.

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

export function localModelFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let url: URL;
    if (typeof input === "string") {
      url = new URL(input);
    } else if (input instanceof URL) {
      url = input;
    } else {
      url = new URL((input as Request).url);
    }

    const isHttps = url.protocol === "https:";
    const transport: typeof http | typeof https = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const method = init?.method ?? "GET";
    const rawHeaders = init?.headers ?? {};
    const headersRecord: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headersRecord[k] = v;
      });
    } else if (Array.isArray(rawHeaders)) {
      rawHeaders.forEach(([k, v]) => {
        headersRecord[k] = v;
      });
    } else {
      Object.assign(headersRecord, rawHeaders);
    }

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: headersRecord,
      agent,
      // deliberately no `timeout` — let local models take as long as needed
    };

    const req = transport.request(options, (res) => {
      const status = res.statusCode ?? 200;
      const resHeaders = new Headers();
      Object.entries(res.headers).forEach(([k, v]) => {
        if (v === undefined) return;
        const vals = Array.isArray(v) ? v : [v];
        vals.forEach((val) => resHeaders.append(k, val));
      });

      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          res.on("data", (chunk: Buffer) =>
            ctrl.enqueue(new Uint8Array(chunk)),
          );
          res.on("end", () => ctrl.close());
          res.on("error", (err) => ctrl.error(err));
        },
        cancel() {
          res.destroy();
        },
      });

      resolve(new Response(body, { status, headers: resHeaders }));
    });

    req.on("error", reject);

    const signal = init?.signal;
    if (signal) {
      const onAbort = () => {
        req.destroy();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    const body = init?.body;
    if (body != null) {
      if (typeof body === "string" || body instanceof Uint8Array) {
        req.write(body);
      } else if (body instanceof ArrayBuffer) {
        req.write(Buffer.from(body));
      }
    }

    req.end();
  });
}
