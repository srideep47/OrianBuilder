import React from "react";
import { CustomTagState } from "./stateTypes";
import { OrianBuilderDbProjectInfo } from "./OrianBuilderDbProjectInfo";

interface OrianBuilderNeonProjectInfoProps {
  node: {
    properties: {
      state?: CustomTagState;
    };
  };
  children: React.ReactNode;
}

export function OrianBuilderNeonProjectInfo(
  props: OrianBuilderNeonProjectInfoProps,
) {
  return <OrianBuilderDbProjectInfo provider="Neon" {...props} />;
}
