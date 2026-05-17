import React, { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

import {
  useAgentTools,
  type AgentToolName,
  type AgentTool,
} from "@/hooks/useAgentTools";
import { useSettings } from "@/hooks/useSettings";
import { Loader2, ChevronRight } from "lucide-react";
import { AgentToolConsent } from "@/lib/schemas";
import { useTranslation } from "react-i18next";
import type { MissionAutonomyProfile } from "@/ipc/types/mission";
import { SETTING_IDS } from "@/lib/settingsSearchIndex";

export function AgentToolsSettings() {
  const { tools, isLoading, setConsent } = useAgentTools();
  const { t } = useTranslation("settings");
  const [showAutoApproved, setShowAutoApproved] = useState(false);

  const handleConsentChange = (
    toolName: AgentToolName,
    consent: AgentToolConsent,
  ) => {
    setConsent({ toolName, consent });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const autoApprovedTools =
    tools?.filter((t: AgentTool) => t.isAllowedByDefault) || [];
  const requiresApprovalTools =
    tools?.filter((t: AgentTool) => !t.isAllowedByDefault) || [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {t("agentPermissions.description")}
      </p>

      <AutonomyProfileSelector />

      {/* Requires approval tools */}
      <div className="space-y-2">
        {requiresApprovalTools.map((tool: AgentTool) => (
          <ToolConsentRow
            key={tool.name}
            name={tool.name}
            description={tool.description}
            consent={tool.consent}
            onConsentChange={(consent) =>
              handleConsentChange(tool.name as AgentToolName, consent)
            }
          />
        ))}
      </div>

      {/* Auto-approved tools (collapsed by default) */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setShowAutoApproved(!showAutoApproved)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight
            className={`size-4 transition-transform ${showAutoApproved ? "rotate-90" : ""}`}
          />
          <span>
            {t("agentPermissions.defaultAllowedTools", {
              count: autoApprovedTools.length,
            })}
          </span>
        </button>
        {showAutoApproved && (
          <div className="space-y-2 pl-6">
            {autoApprovedTools.map((tool: AgentTool) => (
              <ToolConsentRow
                key={tool.name}
                name={tool.name}
                description={tool.description}
                consent={tool.consent}
                onConsentChange={(consent) =>
                  handleConsentChange(tool.name as AgentToolName, consent)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AutonomyProfileSelector() {
  const { settings, updateSettings } = useSettings();

  if (!settings) {
    return null;
  }

  const selectedProfile =
    settings.defaultMissionAutonomyProfile ?? "trusted-workspace";

  const handleProfileChange = (profile: MissionAutonomyProfile) => {
    void updateSettings({ defaultMissionAutonomyProfile: profile });
  };

  return (
    <div id={SETTING_IDS.defaultMissionAutonomyProfile} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Label
            htmlFor="default-mission-autonomy-profile"
            className="text-sm font-medium"
          >
            Default mission autonomy
          </Label>
          <p className="text-xs text-muted-foreground">
            Controls how much unattended authority new missions receive.
          </p>
        </div>
        <Select
          value={selectedProfile}
          onValueChange={(value) =>
            handleProfileChange(value as MissionAutonomyProfile)
          }
        >
          <SelectTrigger
            id="default-mission-autonomy-profile"
            className="w-full sm:w-[240px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="supervised">Supervised</SelectItem>
            <SelectItem value="trusted-workspace">Trusted workspace</SelectItem>
            <SelectItem value="full-autopilot-sandbox">
              Full autopilot sandbox
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {getProfileDescription(selectedProfile)}
      </p>
    </div>
  );
}

function getProfileDescription(profile: MissionAutonomyProfile) {
  switch (profile) {
    case "supervised":
      return "Ask before every consent-gated tool action.";
    case "trusted-workspace":
      return "Automatically allow scoped workspace edits and preview checks, but ask for shell, external, high-risk, and delete actions.";
    case "full-autopilot-sandbox":
      return "Automatically allow most non-critical actions. High-risk host actions still ask, and critical destructive actions are blocked.";
    default:
      return "";
  }
}

function ToolConsentRow({
  name,
  description,
  consent,
  onConsentChange,
}: {
  name: string;
  description: string;
  consent: AgentToolConsent;
  onConsentChange: (consent: AgentToolConsent) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="border rounded p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm">{name}</div>
          <div className="text-xs text-muted-foreground truncate">
            {description?.slice(0, 100)} {description?.length > 100 && "..."}
          </div>
        </div>
        <Select
          value={consent}
          onValueChange={(v) => onConsentChange(v as AgentToolConsent)}
        >
          <SelectTrigger className="w-[140px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">{t("agentPermissions.ask")}</SelectItem>
            <SelectItem value="always">
              {t("agentPermissions.alwaysAllow")}
            </SelectItem>
            <SelectItem value="never">
              {t("agentPermissions.neverAllow")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
