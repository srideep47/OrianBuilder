import React, { useMemo, useState } from "react";
import { Boxes, FileSearch, FolderTree, Wrench } from "lucide-react";
import {
  OrianBuilderBadge,
  OrianBuilderCard,
  OrianBuilderCardContent,
  OrianBuilderCardHeader,
  OrianBuilderExpandIcon,
} from "./OrianBuilderCardPrimitives";

function getSummaryLine(content: string, fallback: string): string {
  const line = content
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line || fallback;
}

export function OrianBuilderProjectStack({
  attributes,
  children,
}: {
  attributes: Record<string, string>;
  children?: React.ReactNode;
}) {
  const framework = attributes.framework || "unknown";
  const kind = attributes.kind || "project";
  const packageManager = attributes["package-manager"] || "npm";
  const confidence = attributes.confidence || "";
  const content = typeof children === "string" ? children : "";
  const [expanded, setExpanded] = useState(false);

  return (
    <OrianBuilderCard
      accentColor="blue"
      isExpanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <OrianBuilderCardHeader icon={<Boxes size={15} />} accentColor="blue">
        <OrianBuilderBadge color="blue">Project detected</OrianBuilderBadge>
        <span className="text-sm text-muted-foreground">
          {framework} · {kind} · {packageManager}
        </span>
        {confidence && (
          <OrianBuilderBadge color="slate">{confidence}</OrianBuilderBadge>
        )}
        <div className="ml-auto">
          <OrianBuilderExpandIcon isExpanded={expanded} />
        </div>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={expanded}>
        <div className="p-3 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto bg-muted/20 rounded-lg">
          {content}
        </div>
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
}

export function OrianBuilderRepoMap({
  attributes,
  children,
}: {
  attributes: Record<string, string>;
  children?: React.ReactNode;
}) {
  const content = typeof children === "string" ? children : "";
  const files = attributes.files || "";
  const [expanded, setExpanded] = useState(false);

  return (
    <OrianBuilderCard
      accentColor="purple"
      isExpanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <OrianBuilderCardHeader
        icon={<FolderTree size={15} />}
        accentColor="purple"
      >
        <OrianBuilderBadge color="purple">Repository map</OrianBuilderBadge>
        <span className="text-sm text-muted-foreground">
          {files ? `${files} file${files === "1" ? "" : "s"}` : "Code index"}
        </span>
        <div className="ml-auto">
          <OrianBuilderExpandIcon isExpanded={expanded} />
        </div>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={expanded}>
        <div className="p-3 text-xs font-mono whitespace-pre-wrap max-h-72 overflow-y-auto bg-muted/20 rounded-lg">
          {content}
        </div>
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
}

export function OrianBuilderAgentAction({
  attributes,
}: {
  attributes: Record<string, string>;
}) {
  const tool = attributes.tool || "tool";
  const label = attributes.label || tool.replace(/_/g, " ");
  const detail = attributes.detail || "";

  const icon = useMemo(() => {
    if (tool.includes("read") || tool.includes("search")) {
      return <FileSearch size={14} />;
    }
    return <Wrench size={14} />;
  }, [tool]);

  return (
    <div className="my-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span className="text-muted-foreground/60">{icon}</span>
      <span className="font-medium text-foreground/70">{label}</span>
      {detail && (
        <span className="truncate font-mono text-muted-foreground/80">
          {detail}
        </span>
      )}
    </div>
  );
}

export function OrianBuilderAgentNote({
  children,
}: {
  children?: React.ReactNode;
}) {
  const content = typeof children === "string" ? children : "";
  return (
    <div className="my-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      {getSummaryLine(content, "Agent activity")}
    </div>
  );
}
