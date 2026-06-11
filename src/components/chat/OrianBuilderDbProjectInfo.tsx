import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { CustomTagState } from "./stateTypes";
import { Database } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderExpandIcon,
  OrianBuilderStateIndicator,
  OrianBuilderCardContent,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderDbProjectInfoProps {
  provider: string;
  node: {
    properties: {
      state?: CustomTagState;
    };
  };
  children: React.ReactNode;
}

export function OrianBuilderDbProjectInfo({
  provider,
  node,
  children,
}: OrianBuilderDbProjectInfoProps) {
  const { t } = useTranslation("home");
  const [isContentVisible, setIsContentVisible] = useState(false);
  const { state } = node.properties;
  const isLoading = state === "pending";
  const isAborted = state === "aborted";
  const content = typeof children === "string" ? children : "";

  return (
    <OrianBuilderCard
      state={state}
      accentColor="teal"
      isExpanded={isContentVisible}
      onClick={() => setIsContentVisible(!isContentVisible)}
    >
      <OrianBuilderCardHeader icon={<Database size={15} />} accentColor="teal">
        <OrianBuilderBadge color="teal">
          {t("integrations.db.projectInfo", { provider })}
        </OrianBuilderBadge>
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
