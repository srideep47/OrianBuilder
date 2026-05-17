import React from "react";
import { CustomTagState } from "./stateTypes";
import { OrianBuilderDbProjectInfo } from "./OrianBuilderDbProjectInfo";

interface OrianBuilderSupabaseProjectInfoProps {
  node: {
    properties: {
      state?: CustomTagState;
    };
  };
  children: React.ReactNode;
}

export function OrianBuilderSupabaseProjectInfo(
  props: OrianBuilderSupabaseProjectInfoProps,
) {
  return <OrianBuilderDbProjectInfo provider="Supabase" {...props} />;
}
