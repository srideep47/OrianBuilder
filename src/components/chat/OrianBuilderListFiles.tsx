import React, { useState } from "react";
import { CustomTagState } from "./stateTypes";
import { FolderOpen } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderExpandIcon,
  OrianBuilderStateIndicator,
  OrianBuilderCardContent,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderListFilesProps {
  node: {
    properties: {
      directory?: string;
      recursive?: string;
      include_ignored?: string;
      state?: CustomTagState;
      appName?: string;
    };
  };
  children: React.ReactNode;
}

export function OrianBuilderListFiles({
  node,
  children,
}: OrianBuilderListFilesProps) {
  const { directory, recursive, include_ignored, state, appName } =
    node.properties;
  const isLoading = state === "pending";
  const isRecursive = recursive === "true";
  const isIncludeIgnored = include_ignored === "true";
  const content = typeof children === "string" ? children : "";
  const [isExpanded, setIsExpanded] = useState(false);

  const title = directory ? directory : "List Files";

  return (
    <OrianBuilderCard
      state={state}
      accentColor="slate"
      isExpanded={isExpanded}
      onClick={() => setIsExpanded(!isExpanded)}
      data-testid="orianbuilder-list-files"
    >
      <OrianBuilderCardHeader
        icon={<FolderOpen size={15} />}
        accentColor="slate"
      >
        <span className="font-medium text-sm text-foreground truncate">
          {title}
        </span>
        {appName && (
          <OrianBuilderBadge color="sky">{appName}</OrianBuilderBadge>
        )}
        {isRecursive && (
          <OrianBuilderBadge color="slate">recursive</OrianBuilderBadge>
        )}
        {isIncludeIgnored && (
          <OrianBuilderBadge color="slate">include ignored</OrianBuilderBadge>
        )}
        {isLoading && (
          <OrianBuilderStateIndicator
            state="pending"
            pendingLabel="Listing..."
          />
        )}
        <div className="ml-auto">
          <OrianBuilderExpandIcon isExpanded={isExpanded} />
        </div>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={isExpanded}>
        {content && (
          <div className="p-3 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-y-auto bg-muted/20 rounded-2xl">
            {content}
          </div>
        )}
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
}
