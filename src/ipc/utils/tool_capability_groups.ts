import {
  TOOL_CAPABILITIES,
  type ToolCapability,
  type ToolStateScope,
} from "./tool_capabilities";

export type ToolCapabilityGroupKey =
  | "read_only"
  | "workspace"
  | "runtime"
  | "external";

export type ToolCapabilityListItem = ToolCapability & {
  toolName: string;
  alwaysAsk: boolean;
};

export type ToolCapabilityGroup = {
  key: ToolCapabilityGroupKey;
  label: string;
  items: ToolCapabilityListItem[];
};

export const ALWAYS_ASK_TOOL_NAMES = new Set(["deploy_preview"]);

const GROUP_ORDER: Array<{
  key: ToolCapabilityGroupKey;
  label: string;
  scopes: ToolStateScope[];
}> = [
  { key: "read_only", label: "Read-only", scopes: ["read_only"] },
  { key: "workspace", label: "Workspace", scopes: ["workspace"] },
  { key: "runtime", label: "Runtime", scopes: ["runtime"] },
  { key: "external", label: "External/host", scopes: ["external", "host"] },
];

export function getGroupedToolCapabilities(): ToolCapabilityGroup[] {
  const items = Object.entries(TOOL_CAPABILITIES)
    .map(([toolName, capability]) => ({
      toolName,
      ...capability,
      alwaysAsk: ALWAYS_ASK_TOOL_NAMES.has(toolName),
    }))
    .sort((first, second) => first.toolName.localeCompare(second.toolName));

  return GROUP_ORDER.map((group) => ({
    key: group.key,
    label: group.label,
    items: items.filter((item) => group.scopes.includes(item.stateScope)),
  }));
}

export function getToolCapabilityGroupCounts() {
  return getGroupedToolCapabilities().reduce(
    (counts, group) => ({
      ...counts,
      [group.key]: group.items.length,
    }),
    {} as Record<ToolCapabilityGroupKey, number>,
  );
}
