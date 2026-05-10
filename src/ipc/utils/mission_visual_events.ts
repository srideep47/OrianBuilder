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
    | "browser_action_recorded"
    | "runtime_preview_checked";
  summary: string;
  gate: MissionVisualGate;
  status: MissionVisualGateStatus;
  metadata: Record<string, unknown>;
};

export type MissionVisualArtifact = {
  artifactType:
    | "screenshot"
    | "image"
    | "audio"
    | "video"
    | "deployment"
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

  if (xml.startsWith("<orianbuilder-screenshot")) {
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

  if (xml.startsWith("<orianbuilder-accessibility-tree")) {
    const url = getXmlAttribute(xml, "url");
    const error = getXmlAttribute(xml, "error");
    const body = extractTagBody(xml, "orianbuilder-accessibility-tree");
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

  if (xml.startsWith("<orianbuilder-console-output")) {
    const filter = getXmlAttribute(xml, "filter");
    const countRaw = getXmlAttribute(xml, "count");
    const count = countRaw === undefined ? undefined : Number(countRaw);
    const body = extractTagBody(xml, "orianbuilder-console-output");
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

  if (xml.startsWith("<orianbuilder-terminal-command")) {
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

  if (xml.startsWith("<orianbuilder-runtime-session")) {
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
    const body =
      extractTagBody(xml, "orianbuilder-runtime-session")?.trim() ?? "";
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

  if (xml.startsWith("<orianbuilder-runtime-output")) {
    const runtimeStatus = getXmlAttribute(xml, "status");
    const url = getXmlAttribute(xml, "url");
    const body =
      extractTagBody(xml, "orianbuilder-runtime-output")?.trim() ?? "";
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

  if (xml.startsWith("<orianbuilder-browser-action")) {
    const action = getXmlAttribute(xml, "action");
    const url = getXmlAttribute(xml, "url");
    const path = getXmlAttribute(xml, "path");
    const body =
      extractTagBody(xml, "orianbuilder-browser-action")?.trim() ?? "";
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
    events.push({
      eventType: "browser_action_recorded",
      summary: `Browser action: ${action ?? "unknown"}`,
      gate:
        action === "screenshot"
          ? "screenshot"
          : action === "snapshot"
            ? "accessibility"
            : "runtime",
      status: "passed",
      metadata: {
        action: action ?? null,
        url: url ?? null,
        path: path || null,
        chars: body.length,
        source: "browser_control",
      },
    });
  }

  if (xml.startsWith("<orianbuilder-browser-qa")) {
    const status = getXmlAttribute(xml, "status");
    const runtimeStatus = getXmlAttribute(xml, "runtime-status");
    const runtimeUrl = getXmlAttribute(xml, "runtime-url");
    const runtimeError = getXmlAttribute(xml, "runtime-error");
    const browserError = getXmlAttribute(xml, "browser-error");
    const screenshotStatus = getXmlAttribute(xml, "screenshot-status");
    const desktopPath = getXmlAttribute(xml, "desktop-path");
    const mobilePath = getXmlAttribute(xml, "mobile-path");
    const accessibilityStatus = getXmlAttribute(xml, "accessibility-status");
    const consoleStatus = getXmlAttribute(xml, "console-status");
    const body = extractTagBody(xml, "orianbuilder-browser-qa")?.trim() ?? "";

    if (runtimeStatus) {
      events.push({
        eventType: "runtime_preview_checked",
        summary:
          runtimeStatus === "passed"
            ? `Runtime ready: ${runtimeUrl ?? "preview"}`
            : `Runtime failed: ${runtimeError || "browser QA gate failed"}`,
        gate: "runtime",
        status: runtimeStatus === "passed" ? "passed" : "failed",
        metadata: {
          source: "browser_qa_gate",
          status: status ?? null,
          url: runtimeUrl ?? null,
          error: runtimeError || browserError || null,
        },
      });
      artifacts.push({
        artifactType: "runtime",
        title: "Browser QA runtime",
        body: body || null,
        uri: runtimeUrl ?? null,
        mimeType: body ? "text/plain" : null,
        metadata: {
          source: "browser_qa_gate",
          status: runtimeStatus,
          error: runtimeError || browserError || null,
        },
      });
    }

    for (const [viewport, screenshotPath] of [
      ["desktop", desktopPath],
      ["mobile", mobilePath],
    ] as const) {
      if (!screenshotPath) continue;
      events.push({
        eventType: "visual_screenshot_captured",
        summary: `Browser QA ${viewport} screenshot captured (${screenshotPath})`,
        gate: "screenshot",
        status: screenshotStatus === "passed" ? "passed" : "failed",
        metadata: {
          source: "browser_qa_gate",
          viewport,
          path: screenshotPath,
          url: runtimeUrl ?? null,
        },
      });
      artifacts.push({
        artifactType: "screenshot",
        title: `Browser QA ${viewport} screenshot`,
        uri: screenshotPath,
        mimeType: "image/png",
        metadata: {
          source: "browser_qa_gate",
          viewport,
          url: runtimeUrl ?? null,
        },
      });
    }

    if (accessibilityStatus) {
      events.push({
        eventType: "visual_accessibility_captured",
        summary:
          accessibilityStatus === "passed"
            ? "Browser QA accessibility snapshot captured"
            : "Browser QA accessibility snapshot failed",
        gate: "accessibility",
        status: accessibilityStatus === "passed" ? "passed" : "failed",
        metadata: {
          source: "browser_qa_gate",
          url: runtimeUrl ?? null,
          chars: body.length,
        },
      });
      if (body.length > 0) {
        artifacts.push({
          artifactType: "accessibility_tree",
          title: "Browser QA accessibility snapshot",
          body,
          mimeType: "text/plain",
          metadata: {
            source: "browser_qa_gate",
            url: runtimeUrl ?? null,
          },
        });
      }
    }

    if (consoleStatus) {
      events.push({
        eventType: "visual_console_checked",
        summary:
          consoleStatus === "passed"
            ? "Browser QA console clean"
            : "Browser QA console reported errors",
        gate: "console",
        status: consoleStatus === "passed" ? "passed" : "failed",
        metadata: {
          source: "browser_qa_gate",
          url: runtimeUrl ?? null,
        },
      });
      if (body.length > 0) {
        artifacts.push({
          artifactType: "console_output",
          title: "Browser QA console report",
          body,
          mimeType: "text/plain",
          metadata: {
            source: "browser_qa_gate",
            url: runtimeUrl ?? null,
            status: consoleStatus,
          },
        });
      }
    }
  }

  if (xml.startsWith("<orianbuilder-image-generation")) {
    const prompt = getXmlAttribute(xml, "prompt");
    const path = getXmlAttribute(xml, "path");
    const body =
      extractTagBody(xml, "orianbuilder-image-generation")?.trim() ?? "";
    if (path) {
      artifacts.push({
        artifactType: "image",
        title: "Generated image",
        uri: path,
        body: body || null,
        mimeType: "image/png",
        metadata: {
          prompt: prompt ?? null,
          source: "generate_image",
        },
      });
    }
  }

  if (xml.startsWith("<orianbuilder-media-generation")) {
    const kind = getXmlAttribute(xml, "kind");
    const prompt = getXmlAttribute(xml, "prompt");
    const path = getXmlAttribute(xml, "path");
    const mimeType = getXmlAttribute(xml, "mime-type");
    const provider = getXmlAttribute(xml, "provider");
    const error = getXmlAttribute(xml, "error");
    const body =
      extractTagBody(xml, "orianbuilder-media-generation")?.trim() ?? "";
    if (path && (kind === "image" || kind === "audio" || kind === "video")) {
      artifacts.push({
        artifactType: kind,
        title: `Generated ${kind}`,
        uri: path,
        body: body || null,
        mimeType: mimeType ?? null,
        metadata: {
          prompt: prompt ?? null,
          source: "generate_media_asset",
          provider: provider ?? null,
          error: error || null,
        },
      });
    }
  }

  if (xml.startsWith("<orianbuilder-deploy-preview")) {
    const provider = getXmlAttribute(xml, "provider");
    const target = getXmlAttribute(xml, "target");
    const ref = getXmlAttribute(xml, "ref");
    const status = getXmlAttribute(xml, "status");
    const url = getXmlAttribute(xml, "url");
    const projectId = getXmlAttribute(xml, "project-id");
    const projectName = getXmlAttribute(xml, "project-name");
    const state = getXmlAttribute(xml, "state");
    const initialState = getXmlAttribute(xml, "initial-state");
    const error = getXmlAttribute(xml, "error");
    const buildLogStatus = getXmlAttribute(xml, "build-log-status");
    const buildLogCountRaw = getXmlAttribute(xml, "build-log-count");
    const buildLogCount =
      buildLogCountRaw === undefined ? undefined : Number(buildLogCountRaw);
    const body =
      extractTagBody(xml, "orianbuilder-deploy-preview")?.trim() ?? "";
    if (url) {
      artifacts.push({
        artifactType: "deployment",
        title: `${provider ?? "Vercel"} ${target ?? "preview"} deployment`,
        uri: url,
        body: body || null,
        mimeType: body ? "text/plain" : null,
        metadata: {
          source: "deploy_preview",
          provider: provider ?? "vercel",
          target: target ?? null,
          ref: ref ?? null,
          status: status ?? null,
          state: state ?? null,
          initialState: initialState ?? null,
          error: error || null,
          buildLogStatus: buildLogStatus ?? null,
          buildLogCount: Number.isFinite(buildLogCount) ? buildLogCount : null,
          projectId: projectId ?? null,
          projectName: projectName ?? null,
        },
      });
    }
  }

  return { events, artifacts };
}
