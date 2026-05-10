import React, { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { VanillaMarkdownParser } from "./OrianBuilderMarkdownParser";
import { CustomTagState } from "./stateTypes";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderExpandIcon,
  OrianBuilderStateIndicator,
  OrianBuilderCardContent,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderWebSearchResultProps {
  node?: any;
  children?: React.ReactNode;
}

export const OrianBuilderWebSearchResult: React.FC<
  OrianBuilderWebSearchResultProps
> = ({ children, node }) => {
  const state = node?.properties?.state as CustomTagState;
  const inProgress = state === "pending";
  const [isExpanded, setIsExpanded] = useState(inProgress);

  useEffect(() => {
    if (!inProgress && isExpanded) {
      setIsExpanded(false);
    }
  }, [inProgress]);

  return (
    <OrianBuilderCard
      state={state}
      accentColor="blue"
      onClick={() => setIsExpanded(!isExpanded)}
      isExpanded={isExpanded}
    >
      <OrianBuilderCardHeader icon={<Globe size={15} />} accentColor="blue">
        <OrianBuilderBadge color="blue">Web Search Result</OrianBuilderBadge>
        {inProgress && (
          <OrianBuilderStateIndicator
            state="pending"
            pendingLabel="Loading..."
          />
        )}
        <div className="ml-auto">
          <OrianBuilderExpandIcon isExpanded={isExpanded} />
        </div>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={isExpanded}>
        <div className="text-sm text-muted-foreground">
          {typeof children === "string" ? (
            <VanillaMarkdownParser content={children} />
          ) : (
            children
          )}
        </div>
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
};
