import { unescapeXmlAttr, unescapeXmlContent } from "../../../shared/xmlEscape";

export type MissionVisualGate =
  | "screenshot"
  | "accessibility"
  | "console"
  | "runtime";

export type MissionVisualGateStatus = "passed" | "failed" | "unknown";

export type MissionVisualEvent = {
  eventType:
    | "visual_screenshot_captured"
    | "visual_accessibility_captured"
    | "visual_console_checked"
    | "runtime_preview_checked";
  summary: string;
  gate: MissionVisualGate;
  status: MissionVisualGateStatus;
  metadata: Record<string, unknown>;
};

export type MissionVisualArtifact = {
  artifactType:
    | "screenshot"
    | "accessibility_tree"
    | "console_output"
    | "runtime";
  title: string;
  uri?: string | null;
  body?: string | null;
  mimeType?: string | null;
  metadata?: Record<string, unknown>;
};

const RUNTIME_COMMAND_PATTERNS = [
  /\b(dev|start|preview|serve|run\s+dev|run\s+start)\b/i,
  /\bnpm\s+(run\s+)?(dev|start|preview)\b/i,
  /\b(pnpm|yarn|bun)\s+(run\s+)?(dev|start|preview)\b/i,
  /\bnpx\s+(vite|next)\b/i,
];

function isRuntimeCommand(command: string | undefined): boolean {
  if (!command) return false;
  return RUNTIME_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function getXmlAttribute(xml: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`${escapedName}="([^"]*)"`));
  return match?.[1] ? unescapeXmlAttr(match[1]) : undefined;
}

function extractTagBody(xml: string, tagName: string): string | undefined {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`);
  const match = xml.match(regex);
  if (!match) return undefined;
  return unescapeXmlContent(match[1]);
}

export type MissionVisualExtraction = {
  events: MissionVisualEvent[];
  artifacts: MissionVisualArtifact[];
};

export function extractMissionVisualEventsForXml(
  xml: string,
): MissionVisualExtraction {
  const events: MissionVisualEvent[] = [];
  const artifacts: MissionVisualArtifact[] = [];

  if (xml.startsWith("<dyad-screenshot")) {
    const url = getXmlAttribute(xml, "url");
    const path = getXmlAttribute(xml, "path");
    const error = getXmlAttribute(xml, "error");
    const status: MissionVisualGateStatus = error
      ? "failed"
      : path
        ? "passed"
        : "unknown";
    events.push({
      eventType: "visual_screenshot_captured",
      summary: error
        ? `Screenshot failed: ${error}`
        : path
          ? `Screenshot captured (${path})`
          : "Screenshot capture started",
      gate: "screenshot",
      status,
      metadata: {
        url: url ?? null,
        path: path ?? null,
        error: error ?? null,
      },
    });
    if (status === "passed" && path) {
      artifacts.push({
        artifactType: "screenshot",
        title: `Screenshot ${path}`,
        uri: path,
        mimeType: "image/png",
        metadata: { url: url ?? null },
      });
    }
  }

  if (xml.startsWith("<dyad-accessibility-tree")) {
    const url = getXmlAttribute(xml, "url");
    const error = getXmlAttribute(xml, "error");
    const body = extractTagBody(xml, "dyad-accessibility-tree");
    const trimmed = body?.trim();
    const isPlaceholder = !trimmed || trimmed === "Reading…";
    const status: MissionVisualGateStatus = error
      ? "failed"
      : !isPlaceholder
        ? "passed"
        : "unknown";
    events.push({
      eventType: "visual_accessibility_captured",
      summary: error
        ? `Accessibility tree failed: ${error}`
        : !isPlaceholder
          ? "Accessibility tree captured"
          : "Accessibility tree pending",
      gate: "accessibility",
      status,
      metadata: {
        url: url ?? null,
        error: error ?? null,
        chars: trimmed ? trimmed.length : 0,
      },
    });
    if (status === "passed" && trimmed) {
      artifacts.push({
        artifactType: "accessibility_tree",
        title: url ? `A11y tree of ${url}` : "Accessibility tree",
        body: trimmed,
        mimeType: "text/plain",
        metadata: { url: url ?? null },
      });
    }
  }

  if (xml.startsWith("<dyad-console-output")) {
    const filter = getXmlAttribute(xml, "filter");
    const countRaw = getXmlAttribute(xml, "count");
    const count = countRaw === undefined ? undefined : Number(countRaw);
    const body = extractTagBody(xml, "dyad-console-output");
    const trimmedBody = body?.trim() ?? "";
    const lower = trimmedBody.toLowerCase();
    const looksClean =
      count === 0 ||
      (count !== undefined && count >= 0 && /running cleanly/.test(lower)) ||
      /no\s+(errors|warnings|errors and warnings|console output)/.test(lower);
    const hasErrors =
      filter === "errors" ||
      filter === "errors_and_warnings" ||
      filter === "all"
        ? !looksClean && (count ?? 0) > 0
        : false;
    const status: MissionVisualGateStatus =
      count === undefined
        ? "unknown"
        : looksClean
          ? "passed"
          : hasErrors
            ? "failed"
            : "unknown";
    events.push({
      eventType: "visual_console_checked",
      summary:
        status === "passed"
          ? "Console clean"
          : status === "failed"
            ? `Console reported ${count ?? "?"} entries`
            : "Console checked",
      gate: "console",
      status,
      metadata: {
        filter: filter ?? null,
        count: Number.isFinite(count) ? count : null,
      },
    });
    if (trimmedBody.length > 0) {
      artifacts.push({
        artifactType: "console_output",
        title: `Console output (${filter ?? "all"})`,
        body: trimmedBody,
        mimeType: "text/plain",
        metadata: {
          filter: filter ?? null,
          count: Number.isFinite(count) ? count : null,
        },
      });
    }
  }

  if (xml.startsWith("<dyad-terminal-command")) {
    const command = getXmlAttribute(xml, "cmd");
    if (isRuntimeCommand(command)) {
      const exitCodeRaw = getXmlAttribute(xml, "exit-code");
      const exitCode =
        exitCodeRaw === undefined ? undefined : Number(exitCodeRaw);
      const status: MissionVisualGateStatus =
        exitCode === undefined || Number.isNaN(exitCode)
          ? "unknown"
          : exitCode === 0
            ? "passed"
            : "failed";
      events.push({
        eventType: "runtime_preview_checked",
        summary:
          status === "unknown"
            ? `Runtime command running: ${command}`
            : status === "passed"
              ? `Runtime started: ${command}`
              : `Runtime failed (exit ${exitCode}): ${command}`,
        gate: "runtime",
        status,
        metadata: {
          command: command ?? null,
          exitCode: Number.isFinite(exitCode) ? exitCode : null,
        },
      });
    }
  }

  if (xml.startsWith("<dyad-runtime-session")) {
    const runtimeStatus = getXmlAttribute(xml, "status");
    const ready = getXmlAttribute(xml, "ready") === "true";
    const url = getXmlAttribute(xml, "url");
    const mode = getXmlAttribute(xml, "mode");
    const error = getXmlAttribute(xml, "error");
    const status: MissionVisualGateStatus = ready
      ? "passed"
      : runtimeStatus === "failed"
        ? "failed"
        : "unknown";
    const body = extractTagBody(xml, "dyad-runtime-session")?.trim() ?? "";
    events.push({
      eventType: "runtime_preview_checked",
      summary: ready
        ? `Runtime ready: ${url ?? "preview"}`
        : runtimeStatus === "stopped"
          ? "Runtime stopped"
          : runtimeStatus === "failed"
            ? `Runtime failed: ${error ?? "unknown error"}`
            : "Runtime starting",
      gate: "runtime",
      status,
      metadata: {
        runtimeStatus: runtimeStatus ?? null,
        ready,
        url: url ?? null,
        mode: mode ?? null,
        processId: getXmlAttribute(xml, "process-id") ?? null,
        pid: getXmlAttribute(xml, "pid") ?? null,
        statusCode: getXmlAttribute(xml, "status-code") ?? null,
        error: error ?? null,
      },
    });
    if (body.length > 0 || url) {
      artifacts.push({
        artifactType: "runtime",
        title: `Runtime ${runtimeStatus ?? "status"}`,
        body: body || null,
        uri: url ?? null,
        mimeType: body ? "text/plain" : null,
        metadata: {
          runtimeStatus: runtimeStatus ?? null,
          ready,
          mode: mode ?? null,
          error: error ?? null,
        },
      });
    }
  }

  if (xml.startsWith("<dyad-runtime-output")) {
    const runtimeStatus = getXmlAttribute(xml, "status");
    const url = getXmlAttribute(xml, "url");
    const body = extractTagBody(xml, "dyad-runtime-output")?.trim() ?? "";
    artifacts.push({
      artifactType: "runtime",
      title: `Runtime output (${runtimeStatus ?? "unknown"})`,
      body,
      uri: url ?? null,
      mimeType: "text/plain",
      metadata: {
        runtimeStatus: runtimeStatus ?? null,
        mode: getXmlAttribute(xml, "mode") ?? null,
        processId: getXmlAttribute(xml, "process-id") ?? null,
        pid: getXmlAttribute(xml, "pid") ?? null,
      },
    });
  }

  if (xml.startsWith("<dyad-browser-action")) {
    const action = getXmlAttribute(xml, "action");
    const url = getXmlAttribute(xml, "url");
    const path = getXmlAttribute(xml, "path");
    const body = extractTagBody(xml, "dyad-browser-action")?.trim() ?? "";
    if (action === "screenshot" && path) {
      events.push({
        eventType: "visual_screenshot_captured",
        summary: `Browser screenshot captured (${path})`,
        gate: "screenshot",
        status: "passed",
        metadata: {
          url: url ?? null,
          path,
          source: "browser_control",
        },
      });
      artifacts.push({
        artifactType: "screenshot",
        title: `Browser screenshot ${path}`,
        uri: path,
        mimeType: "image/png",
        metadata: { url: url ?? null, source: "browser_control" },
      });
    } else if (action === "snapshot" && body.length > 0) {
      events.push({
        eventType: "visual_accessibility_captured",
        summary: "Browser accessibility snapshot captured",
        gate: "accessibility",
        status: "passed",
        metadata: {
          url: url ?? null,
          chars: body.length,
          source: "browser_control",
        },
      });
      artifacts.push({
        artifactType: "accessibility_tree",
        title: url ? `Browser snapshot of ${url}` : "Browser snapshot",
        body,
        mimeType: "text/plain",
        metadata: { url: url ?? null, source: "browser_control" },
      });
    }
  }

  return { events, artifacts };
}
