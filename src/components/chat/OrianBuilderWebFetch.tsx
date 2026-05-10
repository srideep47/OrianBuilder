import type { FC, ReactNode } from "react";
import { Globe } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderStateIndicator,
} from "./OrianBuilderCardPrimitives";
import { CustomTagState } from "./stateTypes";

interface OrianBuilderWebFetchProps {
  children?: ReactNode;
  node?: {
    properties: {
      state?: CustomTagState;
    };
  };
}

export const OrianBuilderWebFetch: FC<OrianBuilderWebFetchProps> = ({
  children,
  node,
}) => {
  const state = node?.properties?.state as CustomTagState;

  return (
    <OrianBuilderCard state={state} accentColor="blue">
      <OrianBuilderCardHeader icon={<Globe size={15} />} accentColor="blue">
        <OrianBuilderBadge color="blue">Web Fetch</OrianBuilderBadge>
        {state && (
          <OrianBuilderStateIndicator
            state={state}
            pendingLabel="Fetching..."
            finishedLabel="Done"
            abortedLabel="Aborted"
          />
        )}
      </OrianBuilderCardHeader>
      {children && (
        <div className="px-3 pb-2 text-sm italic text-muted-foreground">
          {children}
        </div>
      )}
    </OrianBuilderCard>
  );
};
