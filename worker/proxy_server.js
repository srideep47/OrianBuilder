/**
 * proxy.js – zero-dependency worker-based HTTP/WS forwarder
 */

const { parentPort, workerData } = require("worker_threads");

const http = require("http");
const https = require("https");

const { URL } = require("url");
const fs = require("fs");
const path = require("path");

/* ──────────────────────────── worker code ─────────────────────────────── */
const LISTEN_HOST = "localhost";
const LISTEN_PORT = workerData.port;
let rememberedOrigin = null; // e.g. "http://localhost:5173"
let rememberedBaseUrl = null;
const fixedHeaders = workerData?.fixedHeaders || {};

/* ---------- pre-configure rememberedOrigin from workerData ------- */
{
  const fixed = workerData?.targetOrigin;
  if (fixed) {
    try {
      rememberedBaseUrl = new URL(fixed);
      rememberedOrigin = rememberedBaseUrl.origin;
      parentPort?.postMessage(
        `[proxy-worker] fixed upstream origin: ${rememberedOrigin}`,
      );
    } catch {
      throw new Error(
        `Invalid target origin "${fixed}". Must be absolute http/https URL.`,
      );
    }
  }
}

/* ---------- optional resources for HTML injection ---------------------- */

let stacktraceJsContent = null;
let orianbuilderShimContent = null;
let orianbuilderComponentSelectorClientContent = null;
let orianbuilderScreenshotClientContent = null;
let htmlToImageContent = null;
let orianbuilderVisualEditorClientContent = null;
let orianbuilderLogsContent = null;

try {
  const htmlToImagePath = path.join(
    __dirname,
    "..",
    "node_modules",
    "html-to-image",
    "dist",
    "html-to-image.js",
  );
  htmlToImageContent = fs.readFileSync(htmlToImagePath, "utf-8");
  parentPort?.postMessage(
    `[proxy-worker] html-to-image.js loaded from: ${htmlToImagePath}`,
  );
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read html-to-image.js: ${error.message}`,
  );
}

try {
  const stackTraceLibPath = path.join(
    __dirname,
    "..",
    "node_modules",
    "stacktrace-js",
    "dist",
    "stacktrace.min.js",
  );
  stacktraceJsContent = fs.readFileSync(stackTraceLibPath, "utf-8");
  parentPort?.postMessage("[proxy-worker] stacktrace.js loaded.");
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read stacktrace.js: ${error.message}`,
  );
}

try {
  const orianbuilderShimPath = path.join(__dirname, "orianbuilder-shim.js");
  orianbuilderShimContent = fs.readFileSync(orianbuilderShimPath, "utf-8");
  parentPort?.postMessage("[proxy-worker] orianbuilder-shim.js loaded.");
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read orianbuilder-shim.js: ${error.message}`,
  );
}

try {
  const orianbuilderComponentSelectorClientPath = path.join(
    __dirname,
    "orianbuilder-component-selector-client.js",
  );
  orianbuilderComponentSelectorClientContent = fs.readFileSync(
    orianbuilderComponentSelectorClientPath,
    "utf-8",
  );
  parentPort?.postMessage(
    "[proxy-worker] orianbuilder-component-selector-client.js loaded.",
  );
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read orianbuilder-component-selector-client.js: ${error.message}`,
  );
}

try {
  const orianbuilderScreenshotClientPath = path.join(
    __dirname,
    "orianbuilder-screenshot-client.js",
  );
  orianbuilderScreenshotClientContent = fs.readFileSync(
    orianbuilderScreenshotClientPath,
    "utf-8",
  );
  parentPort?.postMessage(
    "[proxy-worker] orianbuilder-screenshot-client.js loaded.",
  );
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read orianbuilder-screenshot-client.js: ${error.message}`,
  );
}

try {
  const orianbuilderVisualEditorClientPath = path.join(
    __dirname,
    "orianbuilder-visual-editor-client.js",
  );
  orianbuilderVisualEditorClientContent = fs.readFileSync(
    orianbuilderVisualEditorClientPath,
    "utf-8",
  );
  parentPort?.postMessage(
    "[proxy-worker] orianbuilder-visual-editor-client.js loaded.",
  );
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read orianbuilder-visual-editor-client.js: ${error.message}`,
  );
}

try {
  const orianbuilderLogsPath = path.join(__dirname, "orianbuilder_logs.js");
  orianbuilderLogsContent = fs.readFileSync(orianbuilderLogsPath, "utf-8");
  parentPort?.postMessage("[proxy-worker] orianbuilder_logs.js loaded.");
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read orianbuilder_logs.js: ${error.message}`,
  );
}

// Load Service Worker files
let orianbuilderSwContent = null;
let orianbuilderSwRegisterContent = null;

try {
  const orianbuilderSwPath = path.join(__dirname, "orianbuilder-sw.js");
  orianbuilderSwContent = fs.readFileSync(orianbuilderSwPath, "utf-8");
  parentPort?.postMessage("[proxy-worker] orianbuilder-sw.js loaded.");
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read orianbuilder-sw.js: ${error.message}`,
  );
}

try {
  const orianbuilderSwRegisterPath = path.join(
    __dirname,
    "orianbuilder-sw-register.js",
  );
  orianbuilderSwRegisterContent = fs.readFileSync(
    orianbuilderSwRegisterPath,
    "utf-8",
  );
  parentPort?.postMessage("[proxy-worker] orianbuilder-sw-register.js loaded.");
} catch (error) {
  parentPort?.postMessage(
    `[proxy-worker] Failed to read orianbuilder-sw-register.js: ${error.message}`,
  );
}

/* ---------------------- helper: need to inject? ------------------------ */
function needsInjection(pathname) {
  // Inject for routes without a file extension (e.g., "/foo", "/foo/bar", "/")
  const ext = path.extname(pathname).toLowerCase();
  return ext === "" || ext === ".html";
}

function injectHTML(buf) {
  let txt = buf.toString("utf8");
  // These are strings that were used since the first version of the orianbuilder shim.
  // If the orianbuilder shim is used from legacy apps which came pre-baked with the shim
  // as a vite plugin, then do not inject the shim twice to avoid weird behaviors.
  const legacyAppWithShim =
    txt.includes("window-error") && txt.includes("unhandled-rejection");

  const scripts = [];

  if (!legacyAppWithShim) {
    if (stacktraceJsContent) {
      scripts.push(`<script>${stacktraceJsContent}</script>`);
    } else {
      scripts.push(
        '<script>console.warn("[proxy-worker] stacktrace.js was not injected.");</script>',
      );
    }

    if (orianbuilderShimContent) {
      scripts.push(`<script>${orianbuilderShimContent}</script>`);
    } else {
      scripts.push(
        '<script>console.warn("[proxy-worker] orianbuilder shim was not injected.");</script>',
      );
    }
  }
  if (orianbuilderComponentSelectorClientContent) {
    scripts.push(
      `<script>${orianbuilderComponentSelectorClientContent}</script>`,
    );
  } else {
    scripts.push(
      '<script>console.warn("[proxy-worker] orianbuilder component selector client was not injected.");</script>',
    );
  }
  if (htmlToImageContent) {
    scripts.push(`<script>${htmlToImageContent}</script>`);
    parentPort?.postMessage(
      "[proxy-worker] html-to-image script injected into HTML.",
    );
  } else {
    scripts.push(
      '<script>console.error("[proxy-worker] html-to-image was not injected - library not loaded.");</script>',
    );
    parentPort?.postMessage(
      "[proxy-worker] WARNING: html-to-image not injected!",
    );
  }
  if (orianbuilderScreenshotClientContent) {
    scripts.push(`<script>${orianbuilderScreenshotClientContent}</script>`);
  } else {
    scripts.push(
      '<script>console.warn("[proxy-worker] orianbuilder screenshot client was not injected.");</script>',
    );
  }
  if (orianbuilderVisualEditorClientContent) {
    scripts.push(`<script>${orianbuilderVisualEditorClientContent}</script>`);
  } else {
    scripts.push(
      '<script>console.warn("[proxy-worker] orianbuilder visual editor client was not injected.");</script>',
    );
  }
  if (orianbuilderLogsContent) {
    scripts.push(`<script>${orianbuilderLogsContent}</script>`);
  } else {
    scripts.push(
      '<script>console.warn("[proxy-worker] orianbuilder_logs.js was not injected.");</script>',
    );
  }
  if (orianbuilderSwRegisterContent) {
    scripts.push(`<script>${orianbuilderSwRegisterContent}</script>`);
  } else {
    scripts.push(
      '<script>console.warn("[proxy-worker] orianbuilder-sw-register.js was not injected.");</script>',
    );
  }
  const allScripts = scripts.join("\n");

  const headRegex = /<head[^>]*>/i;
  if (headRegex.test(txt)) {
    txt = txt.replace(headRegex, `$&\n${allScripts}`);
  } else {
    txt = allScripts + "\n" + txt;
    parentPort?.postMessage(
      "[proxy-worker] Warning: <head> tag not found – scripts prepended.",
    );
  }
  return Buffer.from(txt, "utf8");
}

/* ---------------- helper: build upstream URL from request -------------- */
function buildTargetURL(clientReq) {
  if (!rememberedOrigin || !rememberedBaseUrl)
    throw new Error("No upstream configured.");

  const incomingUrl = new URL(clientReq.url, rememberedOrigin);
  const basePath = rememberedBaseUrl.pathname.replace(/\/$/, "");
  let incomingPath = incomingUrl.pathname;

  if (
    basePath &&
    (incomingPath === basePath || incomingPath.startsWith(`${basePath}/`))
  ) {
    incomingPath = incomingPath.slice(basePath.length) || "/";
  }

  const targetPath =
    incomingPath === "/"
      ? rememberedBaseUrl.pathname
      : `${basePath}${incomingPath}`;

  return new URL(
    `${targetPath}${incomingUrl.search}`,
    rememberedBaseUrl.origin,
  );
}

/* ----------------------------------------------------------------------- */
/* 1. Plain HTTP request / response                                        */
/* ----------------------------------------------------------------------- */

const server = http.createServer((clientReq, clientRes) => {
  // Special handling for Service Worker file
  if (clientReq.url === "/orianbuilder-sw.js") {
    if (orianbuilderSwContent) {
      clientRes.writeHead(200, {
        "content-type": "application/javascript",
        "service-worker-allowed": "/",
        "cache-control": "no-cache",
      });
      clientRes.end(orianbuilderSwContent);
      return;
    } else {
      clientRes.writeHead(404, { "content-type": "text/plain" });
      clientRes.end("Service Worker file not found");
      return;
    }
  }

  let target;
  try {
    target = buildTargetURL(clientReq);
  } catch (err) {
    clientRes.writeHead(400, { "content-type": "text/plain" });
    return void clientRes.end("Bad request: " + err.message);
  }

  const isTLS = target.protocol === "https:";
  const lib = isTLS ? https : http;

  /* Copy request headers but rewrite Host / Origin / Referer */
  const headers = { ...clientReq.headers, host: target.host, ...fixedHeaders };
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) {
    try {
      const ref = new URL(headers.referer);
      headers.referer = target.origin + ref.pathname + ref.search;
    } catch {
      delete headers.referer;
    }
  }
  if (needsInjection(target.pathname)) {
    // Request uncompressed content from upstream
    delete headers["accept-encoding"];
    // Avoid getting cached resources.
    delete headers["if-none-match"];
  }

  const upOpts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isTLS ? 443 : 80),
    path: target.pathname + target.search,
    method: clientReq.method,
    headers,
  };

  const upReq = lib.request(upOpts, (upRes) => {
    const wantsInjection = needsInjection(target.pathname);
    // Only inject when upstream indicates HTML content
    const contentTypeHeader = upRes.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader[0]
      : contentTypeHeader || "";
    const isHtml =
      typeof contentType === "string" &&
      contentType.toLowerCase().includes("text/html");
    const inject = wantsInjection && isHtml;

    if (!inject) {
      clientRes.writeHead(upRes.statusCode, upRes.headers);
      return void upRes.pipe(clientRes);
    }

    const chunks = [];
    upRes.on("data", (c) => chunks.push(c));
    upRes.on("end", () => {
      try {
        const merged = Buffer.concat(chunks);
        const patched = injectHTML(merged);

        const hdrs = {
          ...upRes.headers,
          "content-length": Buffer.byteLength(patched),
        };
        // If we injected content, it's no longer encoded in the original way
        delete hdrs["content-encoding"];
        // Also, remove ETag as content has changed
        delete hdrs["etag"];

        clientRes.writeHead(upRes.statusCode, hdrs);
        clientRes.end(patched);
      } catch (e) {
        clientRes.writeHead(500, { "content-type": "text/plain" });
        clientRes.end("Injection failed: " + e.message);
      }
    });
  });

  clientReq.pipe(upReq);
  upReq.on("error", (e) => {
    clientRes.writeHead(502, { "content-type": "text/plain" });
    clientRes.end("Upstream error: " + e.message);
  });
});

/* ----------------------------------------------------------------------- */
/* 2. WebSocket / generic Upgrade tunnelling                               */
/* ----------------------------------------------------------------------- */

server.on("upgrade", (req, socket, _head) => {
  let target;
  try {
    target = buildTargetURL(req);
  } catch (err) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n" + err.message);
    return socket.destroy();
  }

  const isTLS = target.protocol === "https:";
  const headers = { ...req.headers, host: target.host, ...fixedHeaders };
  if (headers.origin) headers.origin = target.origin;

  const upReq = (isTLS ? https : http).request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isTLS ? 443 : 80),
    path: target.pathname + target.search,
    method: "GET",
    headers,
  });

  upReq.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (upHead && upHead.length) socket.write(upHead);

    upSocket.pipe(socket).pipe(upSocket);
  });

  upReq.on("error", () => socket.destroy());
  upReq.end();
});

/* ----------------------------------------------------------------------- */

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  parentPort?.postMessage(
    `proxy-server-start url=http://${LISTEN_HOST}:${LISTEN_PORT}`,
  );
});
