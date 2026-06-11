import type React from "react";
import type { ReactNode } from "react";
import { useState } from "react";

import { ipc } from "@/ipc/types";

import { Package } from "lucide-react";
import { CodeHighlight } from "./CodeHighlight";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderExpandIcon,
  OrianBuilderCardContent,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderAddDependencyProps {
  children?: ReactNode;
  node?: any;
  packages?: string;
}

export const OrianBuilderAddDependency: React.FC<
  OrianBuilderAddDependencyProps
> = ({ children, node }) => {
  const packages = node?.properties?.packages
    ? node.properties.packages.split(" ").filter(Boolean)
    : [];
  const [isContentVisible, setIsContentVisible] = useState(false);
  const hasChildren = !!children;

  return (
    <OrianBuilderCard
      accentColor="blue"
      isExpanded={isContentVisible}
      onClick={
        hasChildren ? () => setIsContentVisible(!isContentVisible) : undefined
      }
    >
      <OrianBuilderCardHeader icon={<Package size={15} />} accentColor="blue">
        <OrianBuilderBadge color="blue">Add Packages</OrianBuilderBadge>
        {hasChildren && (
          <div className="ml-auto">
            <OrianBuilderExpandIcon isExpanded={isContentVisible} />
          </div>
        )}
      </OrianBuilderCardHeader>
      {packages.length > 0 && (
        <div className="px-3 pb-2">
          <div className="text-sm text-foreground mb-1">
            Do you want to install these packages?
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {packages.map((p: string) => (
              <span
                className="cursor-pointer text-sm px-2 py-0.5 rounded-3xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/60 ring-1 ring-inset ring-blue-200 dark:ring-blue-800 transition-colors"
                key={p}
                onClick={(e) => {
                  e.stopPropagation();
                  ipc.system.openExternalUrl(
                    `https://www.npmjs.com/package/${p}`,
                  );
                }}
              >
                {p}
              </span>
            ))}
          </div>
          <div className="text-xs text-muted-foreground mt-2">
            Make sure these packages are what you want.
          </div>
        </div>
      )}
      <OrianBuilderCardContent isExpanded={isContentVisible}>
        {hasChildren && (
          <div className="text-xs">
            <CodeHighlight className="language-shell">{children}</CodeHighlight>
          </div>
        )}
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
};
