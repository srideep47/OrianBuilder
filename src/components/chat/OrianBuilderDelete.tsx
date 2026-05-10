import type React from "react";
import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
  OrianBuilderFilePath,
  OrianBuilderDescription,
} from "./OrianBuilderCardPrimitives";
import { CustomTagState } from "./stateTypes";

interface OrianBuilderDeleteProps {
  children?: ReactNode;
  node?: any;
  path?: string;
}

export const OrianBuilderDelete: React.FC<OrianBuilderDeleteProps> = ({
  children,
  node,
  path: pathProp,
}) => {
  const path = pathProp || node?.properties?.path || "";
  const state = node?.properties?.state as CustomTagState;
  const fileName = path ? path.split("/").pop() : "";

  return (
    <OrianBuilderCard accentColor="red" state={state}>
      <OrianBuilderCardHeader icon={<Trash2 size={15} />} accentColor="red">
        {fileName && (
          <span className="font-medium text-sm text-foreground truncate">
            {fileName}
          </span>
        )}
        <OrianBuilderBadge color="red">Delete</OrianBuilderBadge>
      </OrianBuilderCardHeader>
      <OrianBuilderFilePath path={path} />
      {children && (
        <OrianBuilderDescription>{children}</OrianBuilderDescription>
      )}
    </OrianBuilderCard>
  );
};
