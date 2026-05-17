import React from "react";
import { CustomTagState } from "./stateTypes";
import { Database } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderStateIndicator,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderDatabaseSchemaProps {
  node: {
    properties: {
      state?: CustomTagState;
    };
  };
  children: React.ReactNode;
}

export function OrianBuilderDatabaseSchema({
  node,
  children,
}: OrianBuilderDatabaseSchemaProps) {
  const { state } = node.properties;
  const isLoading = state === "pending";
  const content = typeof children === "string" ? children : "";

  return (
    <OrianBuilderCard state={state} accentColor="teal">
      <OrianBuilderCardHeader icon={<Database size={15} />} accentColor="teal">
        <OrianBuilderBadge color="teal">Database Schema</OrianBuilderBadge>
        {isLoading && <OrianBuilderStateIndicator state="pending" />}
      </OrianBuilderCardHeader>
      {content && (
        <div className="px-3 pb-3">
          <div className="p-3 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-y-auto bg-muted/20 rounded-lg">
            {content}
          </div>
        </div>
      )}
    </OrianBuilderCard>
  );
}
