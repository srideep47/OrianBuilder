import type React from "react";
import type { ReactNode } from "react";
import { FileEdit } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderFilePath,
  OrianBuilderDescription,
} from "./OrianBuilderCardPrimitives";
import { CustomTagState } from "./stateTypes";

interface OrianBuilderRenameProps {
  children?: ReactNode;
  node?: any;
  from?: string;
  to?: string;
}

export const OrianBuilderRename: React.FC<OrianBuilderRenameProps> = ({
  children,
  node,
  from: fromProp,
  to: toProp,
}) => {
  const from = fromProp || node?.properties?.from || "";
  const to = toProp || node?.properties?.to || "";
  const state = node?.properties?.state as CustomTagState;

  const fromFileName = from ? from.split("/").pop() : "";
  const toFileName = to ? to.split("/").pop() : "";

  const displayTitle =
    fromFileName && toFileName
      ? `${fromFileName} → ${toFileName}`
      : fromFileName || toFileName || "";

  return (
    <OrianBuilderCard accentColor="amber" state={state}>
      <OrianBuilderCardHeader icon={<FileEdit size={15} />} accentColor="amber">
        {displayTitle && (
          <span className="font-medium text-sm text-foreground truncate">
            {displayTitle}
          </span>
        )}
        <OrianBuilderBadge color="amber">Rename</OrianBuilderBadge>
      </OrianBuilderCardHeader>
      {from && <OrianBuilderFilePath path={`From: ${from}`} />}
      {to && <OrianBuilderFilePath path={`To: ${to}`} />}
      {children && (
        <OrianBuilderDescription>{children}</OrianBuilderDescription>
      )}
    </OrianBuilderCard>
  );
};
