import React, { useMemo, useState } from "react";
import { Wrench } from "lucide-react";
import { CodeHighlight } from "./CodeHighlight";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderExpandIcon,
  OrianBuilderCardContent,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderMcpToolCallProps {
  node?: any;
  children?: React.ReactNode;
}

export const OrianBuilderMcpToolCall: React.FC<
  OrianBuilderMcpToolCallProps
> = ({ node, children }) => {
  const serverName: string = node?.properties?.serverName || "";
  const toolName: string = node?.properties?.toolName || "";
  const [expanded, setExpanded] = useState(false);

  const raw = typeof children === "string" ? children : String(children ?? "");

  const prettyJson = useMemo(() => {
    if (!expanded) return "";
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
      console.error("Error parsing JSON for orianbuilder-mcp-tool-call", e);
      return raw;
    }
  }, [expanded, raw]);

  return (
    <OrianBuilderCard
      accentColor="blue"
      isExpanded={expanded}
      onClick={() => setExpanded((v) => !v)}
    >
      <OrianBuilderCardHeader icon={<Wrench size={15} />} accentColor="blue">
        <OrianBuilderBadge color="blue">Tool Call</OrianBuilderBadge>
        {serverName && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 ring-1 ring-inset ring-blue-200 dark:ring-blue-800">
            {serverName}
          </span>
        )}
        {toolName && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground ring-1 ring-inset ring-border">
            {toolName}
          </span>
        )}
        <div className="ml-auto">
          <OrianBuilderExpandIcon isExpanded={expanded} />
        </div>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={expanded}>
        <CodeHighlight className="language-json">{prettyJson}</CodeHighlight>
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
};
