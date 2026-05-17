import type React from "react";
import { useState, type ReactNode } from "react";
import { Globe } from "lucide-react";
import { CustomTagState } from "./stateTypes";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderExpandIcon,
  OrianBuilderStateIndicator,
  OrianBuilderCardContent,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderWebSearchProps {
  children?: ReactNode;
  node?: any;
}

export const OrianBuilderWebSearch: React.FC<OrianBuilderWebSearchProps> = ({
  children,
  node,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const query =
    node?.properties?.query || (typeof children === "string" ? children : "");
  const state = node?.properties?.state as CustomTagState;
  const inProgress = state === "pending";

  return (
    <OrianBuilderCard
      state={state}
      accentColor="blue"
      isExpanded={isExpanded}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <OrianBuilderCardHeader icon={<Globe size={15} />} accentColor="blue">
        <OrianBuilderBadge color="blue">Web Search</OrianBuilderBadge>
        {!isExpanded && query && (
          <span className="text-sm text-muted-foreground italic truncate">
            {query}
          </span>
        )}
        {inProgress && (
          <OrianBuilderStateIndicator
            state="pending"
            pendingLabel="Searching..."
          />
        )}
        <div className="ml-auto">
          <OrianBuilderExpandIcon isExpanded={isExpanded} />
        </div>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={isExpanded}>
        <div className="text-sm text-muted-foreground space-y-2">
          {query && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">
                Query:
              </span>
              <div className="italic mt-0.5 text-foreground">{query}</div>
            </div>
          )}
          {children && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">
                Results:
              </span>
              <div className="mt-0.5 text-foreground">{children}</div>
            </div>
          )}
        </div>
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
};
