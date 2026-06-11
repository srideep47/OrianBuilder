import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { CustomTagState } from "./stateTypes";
import { Table2 } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderExpandIcon,
  OrianBuilderStateIndicator,
  OrianBuilderCardContent,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderDbTableSchemaProps {
  provider: string;
  node: {
    properties: {
      table?: string;
      state?: CustomTagState;
    };
  };
  children: React.ReactNode;
}

export function OrianBuilderDbTableSchema({
  provider,
  node,
  children,
}: OrianBuilderDbTableSchemaProps) {
  const { t } = useTranslation("home");
  const [isContentVisible, setIsContentVisible] = useState(false);
  const { table, state } = node.properties;
  const isLoading = state === "pending";
  const isAborted = state === "aborted";
  const content = typeof children === "string" ? children : "";

  return (
    <OrianBuilderCard
      state={state}
      accentColor="teal"
      onClick={() => setIsContentVisible(!isContentVisible)}
      isExpanded={isContentVisible}
    >
      <OrianBuilderCardHeader icon={<Table2 size={15} />} accentColor="teal">
        <OrianBuilderBadge color="teal">
          {table
            ? t("integrations.db.tableSchema")
            : t("integrations.db.tableSchemaProvider", { provider })}
        </OrianBuilderBadge>
        {table && (
          <span className="font-medium text-sm text-foreground truncate">
            {table}
          </span>
        )}
        {isLoading && (
          <OrianBuilderStateIndicator
            state="pending"
            pendingLabel={t("integrations.db.fetching")}
          />
        )}
        {isAborted && (
          <OrianBuilderStateIndicator
            state="aborted"
            abortedLabel={t("integrations.db.didNotFinish")}
          />
        )}
        <div className="ml-auto">
          <OrianBuilderExpandIcon isExpanded={isContentVisible} />
        </div>
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={isContentVisible}>
        {content && (
          <div className="p-3 text-xs font-mono whitespace-pre-wrap max-h-80 overflow-y-auto bg-muted/20 rounded-2xl">
            {content}
          </div>
        )}
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
}
