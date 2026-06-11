import React, { useState } from "react";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ExternalLink,
  FolderTree,
  Globe,
  Loader2,
  MousePointerClick,
  Package,
  PlugZap,
  Rocket,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  TextSearch,
  XCircle,
  Github,
} from "lucide-react";

import { ipc } from "@/ipc/types";
import {
  OrianBuilderBadge,
  OrianBuilderCard,
  OrianBuilderCardContent,
  OrianBuilderCardHeader,
  OrianBuilderExpandIcon,
  type OrianBuilderAccentColor,
} from "./OrianBuilderCardPrimitives";

export interface ToolCardPresentation {
  icon: React.ReactNode;
  accentColor: OrianBuilderAccentColor;
  badge: string;
  title: string;
  detail?: string;
  status?: "passed" | "failed" | "running" | "ready" | "warning";
  url?: string;
  metaTags?: Array<{ label: string; value: string }>;
}

const STATUS_LABEL: Record<
  NonNullable<ToolCardPresentation["status"]>,
  string
> = {
  passed: "Passed",
  failed: "Failed",
  running: "Running",
  ready: "Ready",
  warning: "Warning",
};

const STATUS_ACCENT: Record<
  NonNullable<ToolCardPresentation["status"]>,
  OrianBuilderAccentColor
> = {
  passed: "green",
  failed: "red",
  running: "amber",
  ready: "emerald",
  warning: "amber",
};

export function getDerivedAccent(
  status: ToolCardPresentation["status"] | undefined,
  fallback: OrianBuilderAccentColor,
): OrianBuilderAccentColor {
  if (!status) return fallback;
  return STATUS_ACCENT[status];
}

function StatusIndicator({
  status,
  inProgress,
}: {
  status?: ToolCardPresentation["status"];
  inProgress?: boolean;
}) {
  if (inProgress || status === "running") {
    return (
      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs shrink-0">
        <Loader2 size={13} className="animate-spin" />
      </span>
    );
  }
  if (status === "failed") {
    return <XCircle size={14} className="text-red-500 shrink-0" />;
  }
  if (status === "passed" || status === "ready") {
    return <CheckCircle2 size={14} className="text-green-600 shrink-0" />;
  }
  if (status === "warning") {
    return <AlertCircle size={14} className="text-amber-500 shrink-0" />;
  }
  return null;
}

export function OrianBuilderToolCard({
  presentation,
  content,
  inProgress,
}: {
  presentation: ToolCardPresentation;
  content?: string;
  inProgress?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const accent = getDerivedAccent(
    presentation.status,
    presentation.accentColor,
  );
  const trimmedContent = (content ?? "").trim();
  const hasOutput = trimmedContent.length > 0;

  const openUrl = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (presentation.url) {
      ipc.system.openExternalUrl(presentation.url);
    }
  };

  return (
    <OrianBuilderCard
      showAccent
      accentColor={accent}
      isExpanded={isExpanded}
      onClick={hasOutput ? () => setIsExpanded((value) => !value) : undefined}
    >
      <OrianBuilderCardHeader icon={presentation.icon} accentColor={accent}>
        <OrianBuilderBadge color={accent}>
          {presentation.badge}
        </OrianBuilderBadge>
        <span className="truncate text-sm font-medium text-foreground">
          {presentation.title}
        </span>
        {presentation.detail && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {presentation.detail}
          </span>
        )}
        {presentation.metaTags?.map((tag) => (
          <span
            key={`${tag.label}-${tag.value}`}
            className="shrink-0 rounded-3xl bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {tag.label} {tag.value}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <StatusIndicator
            status={presentation.status}
            inProgress={inProgress}
          />
          {presentation.status && (
            <span className="hidden sm:inline text-xs text-muted-foreground">
              {STATUS_LABEL[presentation.status]}
            </span>
          )}
          {presentation.url && (
            <button
              type="button"
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-3xl px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={openUrl}
              title={`Open ${presentation.url}`}
            >
              <ExternalLink size={12} />
            </button>
          )}
          {hasOutput && <OrianBuilderExpandIcon isExpanded={isExpanded} />}
        </span>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={isExpanded}>
        {hasOutput && (
          <pre
            className="max-h-72 overflow-auto rounded-2xl bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap"
            onClick={(event) => event.stopPropagation()}
          >
            <code>{trimmedContent}</code>
          </pre>
        )}
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
}

function parseExitCode(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusFromAttribute(
  raw: string | undefined,
): ToolCardPresentation["status"] | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (
    normalized === "passed" ||
    normalized === "success" ||
    normalized === "ok"
  ) {
    return "passed";
  }
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  if (
    normalized === "running" ||
    normalized === "starting" ||
    normalized === "stopping" ||
    normalized === "polling" ||
    normalized === "building"
  ) {
    return "running";
  }
  if (normalized === "ready" || normalized === "stopped") {
    return "ready";
  }
  if (normalized === "warning") {
    return "warning";
  }
  return undefined;
}

export function getToolCardPresentation(
  tag: string,
  attributes: Record<string, string>,
  inProgress: boolean,
): ToolCardPresentation | null {
  switch (tag) {
    case "orianbuilder-terminal-command": {
      const exit = parseExitCode(attributes["exit-code"]);
      const status: ToolCardPresentation["status"] = inProgress
        ? "running"
        : exit === null
          ? undefined
          : exit === 0
            ? "passed"
            : "failed";
      return {
        icon: <Terminal size={14} />,
        accentColor: "slate",
        badge: "Terminal",
        title: inProgress ? "Running command" : "Command",
        detail: attributes.cmd,
        status,
        metaTags:
          exit !== null ? [{ label: "exit", value: String(exit) }] : undefined,
      };
    }

    case "orianbuilder-runtime-session": {
      const status: ToolCardPresentation["status"] = inProgress
        ? "running"
        : statusFromAttribute(attributes.status);
      const ready = attributes.ready === "true";
      return {
        icon: <Server size={14} />,
        accentColor: "sky",
        badge: "Dev server",
        title: inProgress
          ? "Starting dev server"
          : ready
            ? "Dev server ready"
            : status === "failed"
              ? "Dev server failed"
              : "Dev server",
        detail: attributes.url || attributes.mode || attributes.error,
        url: attributes.url || undefined,
        status,
      };
    }

    case "orianbuilder-runtime-output": {
      return {
        icon: <Server size={14} />,
        accentColor: "sky",
        badge: "Dev output",
        title: "Dev server output",
        detail: attributes.url || attributes.mode,
        url: attributes.url || undefined,
        status: inProgress ? "running" : statusFromAttribute(attributes.status),
      };
    }

    case "orianbuilder-browser-qa": {
      const status: ToolCardPresentation["status"] = inProgress
        ? "running"
        : statusFromAttribute(attributes.status);
      const subParts = [
        attributes["runtime-status"] &&
          `runtime: ${attributes["runtime-status"]}`,
        attributes["screenshot-status"] &&
          `screenshot: ${attributes["screenshot-status"]}`,
        attributes["accessibility-status"] &&
          `a11y: ${attributes["accessibility-status"]}`,
        attributes["console-status"] &&
          `console: ${attributes["console-status"]}`,
      ].filter(Boolean) as string[];
      return {
        icon: <ShieldCheck size={14} />,
        accentColor: "emerald",
        badge: "Browser QA",
        title: inProgress
          ? "Running browser QA"
          : status === "failed"
            ? "Browser QA failed"
            : "Browser QA passed",
        detail: subParts.join(" · "),
        status,
        url: attributes["runtime-url"] || undefined,
      };
    }

    case "orianbuilder-browser-action": {
      return {
        icon: <MousePointerClick size={14} />,
        accentColor: "indigo",
        badge: "Browser",
        title: inProgress
          ? "Running browser action"
          : `Browser action: ${attributes.action ?? "action"}`,
        detail: attributes.url || attributes.path,
        url: attributes.url || undefined,
        status: inProgress ? "running" : undefined,
      };
    }

    case "orianbuilder-screenshot": {
      const error = attributes.error;
      const status: ToolCardPresentation["status"] = inProgress
        ? "running"
        : error
          ? "failed"
          : "passed";
      return {
        icon: <Camera size={14} />,
        accentColor: "violet",
        badge: "Screenshot",
        title: inProgress
          ? "Capturing screenshot"
          : error
            ? "Screenshot failed"
            : "Screenshot captured",
        detail: attributes.url || attributes.path,
        url: attributes.url || undefined,
        status,
      };
    }

    case "orianbuilder-native-package": {
      const status: ToolCardPresentation["status"] = inProgress
        ? "running"
        : statusFromAttribute(attributes.status);
      const target = attributes.target || "native";
      const artifactCount = attributes["artifact-count"];
      return {
        icon: <Package size={14} />,
        accentColor: "emerald",
        badge: "Native build",
        title: inProgress
          ? "Packaging native artifact"
          : status === "failed"
            ? "Native packaging failed"
            : `Packaged ${target.replace(/_/g, " ")}`,
        detail:
          attributes["download-site"] ||
          attributes.command ||
          (artifactCount ? `${artifactCount} artifact(s)` : undefined),
        status,
        metaTags: artifactCount
          ? [{ label: "files", value: artifactCount }]
          : undefined,
      };
    }

    case "orianbuilder-deploy-preview": {
      const status: ToolCardPresentation["status"] = inProgress
        ? "running"
        : statusFromAttribute(attributes.status);
      return {
        icon: <Rocket size={14} />,
        accentColor: "indigo",
        badge: "Deploy",
        title: inProgress
          ? "Deploying preview"
          : status === "failed"
            ? "Deployment failed"
            : "Deployment ready",
        detail: attributes.url || attributes.provider || attributes.state,
        url: attributes.url || undefined,
        status,
      };
    }

    case "orianbuilder-accessibility-tree": {
      const error = attributes.error;
      return {
        icon: <TextSearch size={14} />,
        accentColor: "sky",
        badge: "A11y tree",
        title: inProgress
          ? "Reading accessibility tree"
          : error
            ? "A11y tree failed"
            : "Accessibility tree",
        detail: attributes.url,
        url: attributes.url || undefined,
        status: inProgress ? "running" : error ? "failed" : undefined,
      };
    }

    case "orianbuilder-console-output": {
      return {
        icon: <Terminal size={14} />,
        accentColor: "slate",
        badge: "Console",
        title: "Console output",
        detail: attributes.filter
          ? `filter: ${attributes.filter}`
          : attributes.count
            ? `${attributes.count} lines`
            : undefined,
        status: inProgress ? "running" : undefined,
      };
    }

    case "orianbuilder-create-project": {
      const created = attributes.created === "true";
      return {
        icon: <FolderTree size={14} />,
        accentColor: "blue",
        badge: "Scaffold",
        title: inProgress
          ? "Creating project"
          : created
            ? "Project created"
            : "Scaffold result",
        detail: attributes.name
          ? `${attributes.name} (${attributes.stack || "unknown"})`
          : attributes.stack,
        status: inProgress
          ? "running"
          : created
            ? "passed"
            : statusFromAttribute(attributes.status),
        metaTags: attributes["package-manager"]
          ? [{ label: "pm", value: attributes["package-manager"] }]
          : undefined,
      };
    }

    case "orianbuilder-ast-edit": {
      const error = attributes.error;
      return {
        icon: <Sparkles size={14} />,
        accentColor: "violet",
        badge: "AST edit",
        title: inProgress
          ? "Editing AST"
          : error
            ? "AST edit failed"
            : "AST edit complete",
        detail: attributes.file || attributes.operation,
        status: inProgress ? "running" : error ? "failed" : undefined,
      };
    }

    case "orianbuilder-mcp-runtime": {
      return {
        icon: <PlugZap size={14} />,
        accentColor: "blue",
        badge: "MCP",
        title: inProgress
          ? "Managing MCP runtime"
          : `MCP ${attributes.action ?? "runtime"}`,
        detail:
          attributes["server-id"] || attributes.connected
            ? `connected: ${attributes.connected ?? "?"}`
            : undefined,
        status: inProgress ? "running" : undefined,
      };
    }

    case "orianbuilder-media-generation": {
      return {
        icon: <Sparkles size={14} />,
        accentColor: "blue",
        badge: "Media",
        title: inProgress
          ? `Generating ${attributes.kind ?? "media"}`
          : `Generated ${attributes.kind ?? "media"}`,
        detail: attributes.path || attributes.prompt,
        status: inProgress ? "running" : undefined,
      };
    }

    case "orianbuilder-github-pr": {
      return {
        icon: <Github size={14} />,
        accentColor: "slate",
        badge: "GitHub",
        title: inProgress
          ? `GitHub ${attributes.action ?? "action"}…`
          : `GitHub ${attributes.action ?? "action"}`,
        detail:
          attributes["pr-url"] ||
          attributes.branch ||
          (attributes["pr-number"]
            ? `PR #${attributes["pr-number"]}`
            : undefined),
        url: attributes["pr-url"] || undefined,
        status: inProgress ? "running" : statusFromAttribute(attributes.state),
      };
    }

    case "orianbuilder-fetch":
    case "orianbuilder-web-fetch-link": {
      return {
        icon: <Globe size={14} />,
        accentColor: "blue",
        badge: "Fetch",
        title: inProgress ? "Fetching URL" : "Fetched URL",
        detail: attributes.url,
        url: attributes.url || undefined,
        status: inProgress ? "running" : undefined,
      };
    }

    default:
      return null;
  }
}
