import type React from "react";
import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderFilePath,
  OrianBuilderDescription,
  OrianBuilderStateIndicator,
} from "./OrianBuilderCardPrimitives";
import { CustomTagState } from "./stateTypes";

interface OrianBuilderCopyProps {
  children?: ReactNode;
  node?: any;
}

export const OrianBuilderCopy: React.FC<OrianBuilderCopyProps> = ({
  children,
  node,
}) => {
  const from = node?.properties?.from || "";
  const to = node?.properties?.to || "";
  const description = node?.properties?.description || "";
  const state = node?.properties?.state as CustomTagState;

  const toFileName = to ? to.split("/").pop() : "";
  // Hide the "From" line for temp attachment paths (absolute paths) since they
  // show cryptic hash filenames that mean nothing to the user.
  const isTempAttachment =
    /^(\/|[A-Za-z]:\\)/.test(from) || from.includes(".orianbuilder/media/");

  return (
    <OrianBuilderCard accentColor="teal" state={state}>
      <OrianBuilderCardHeader icon={<Copy size={15} />} accentColor="teal">
        {toFileName && (
          <span className="font-medium text-sm text-foreground truncate">
            {toFileName}
          </span>
        )}
        <OrianBuilderBadge color="teal">Copy</OrianBuilderBadge>
        <span className="ml-auto">
          {state === "pending" && (
            <OrianBuilderStateIndicator
              state="pending"
              pendingLabel="Copying..."
            />
          )}
          {state === "aborted" && (
            <OrianBuilderStateIndicator
              state="aborted"
              abortedLabel="Did not finish"
            />
          )}
          {state === "finished" && (
            <OrianBuilderStateIndicator
              state="finished"
              finishedLabel="Copied"
            />
          )}
        </span>
      </OrianBuilderCardHeader>
      {from && !isTempAttachment && (
        <OrianBuilderFilePath path={`From: ${from}`} />
      )}
      {to && <OrianBuilderFilePath path={`To: ${to}`} />}
      {description && (
        <OrianBuilderDescription>{description}</OrianBuilderDescription>
      )}
      {children && (
        <OrianBuilderDescription>{children}</OrianBuilderDescription>
      )}
    </OrianBuilderCard>
  );
};
