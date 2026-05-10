import { useEffect, useState, useRef } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { ProviderSettingsGrid } from "@/components/ProviderSettings";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { ipc } from "@/ipc/types";
import { showSuccess, showError } from "@/lib/toast";
import { AutoApproveSwitch } from "@/components/AutoApproveSwitch";
import { TelemetrySwitch } from "@/components/TelemetrySwitch";
import { MaxChatTurnsSelector } from "@/components/MaxChatTurnsSelector";
import { MaxToolCallStepsSelector } from "@/components/MaxToolCallStepsSelector";
import { ThinkingBudgetSelector } from "@/components/ThinkingBudgetSelector";
import { useSettings } from "@/hooks/useSettings";
import { useAppVersion } from "@/hooks/useAppVersion";
import { useRouter } from "@tanstack/react-router";
import { GitHubIntegration } from "@/components/GitHubIntegration";
import { VercelIntegration } from "@/components/VercelIntegration";
import { SupabaseIntegration } from "@/components/SupabaseIntegration";
import { CustomAppsFolderSelector } from "@/components/CustomAppsFolderSelector";
import { Switch } from "@/components/ui/switch";
import { AutoFixProblemsSwitch } from "@/components/AutoFixProblemsSwitch";
import { AutoExpandPreviewSwitch } from "@/components/AutoExpandPreviewSwitch";
import { KeepPreviewsRunningSwitch } from "@/components/KeepPreviewsRunningSwitch";
import { ChatEventNotificationSwitch } from "@/components/ChatEventNotificationSwitch";
import { AutoUpdateSwitch } from "@/components/AutoUpdateSwitch";
import { ReleaseChannelSelector } from "@/components/ReleaseChannelSelector";
import { NeonIntegration } from "@/components/NeonIntegration";
import { RuntimeModeSelector } from "@/components/RuntimeModeSelector";
import { NodePathSelector } from "@/components/NodePathSelector";
import { ToolsMcpSettings } from "@/components/settings/ToolsMcpSettings";
import { AgentToolsSettings } from "@/components/settings/AgentToolsSettings";
import { ZoomSelector } from "@/components/ZoomSelector";
import { LanguageSelector } from "@/components/LanguageSelector";
import { DefaultChatModeSelector } from "@/components/DefaultChatModeSelector";
import { ContextCompactionSwitch } from "@/components/ContextCompactionSwitch";
import { BlockUnsafeNpmPackagesSwitch } from "@/components/BlockUnsafeNpmPackagesSwitch";
import { CloudSandboxExperimentSwitch } from "@/components/CloudSandboxExperimentSwitch";
import { useSetAtom } from "jotai";
import { activeSettingsSectionAtom } from "@/atoms/viewAtoms";
import { SECTION_IDS, SETTING_IDS } from "@/lib/settingsSearchIndex";
import { BraveSearchSettings } from "@/components/settings/BraveSearchSettings";

const SETTINGS_NAV = [
  { id: SECTION_IDS.general, label: "⚙ General" },
  { id: SECTION_IDS.workflow, label: "⟳ Workflow" },
  { id: SECTION_IDS.ai, label: "✦ AI" },
  { id: SECTION_IDS.providers, label: "▣ Model Providers" },
  { id: SECTION_IDS.telemetry, label: "📊 Telemetry" },
  { id: SECTION_IDS.integrations, label: "🔌 Integrations" },
  { id: SECTION_IDS.agentPermissions, label: "🔐 Permissions" },
  { id: SECTION_IDS.toolsMcp, label: "🛠 Tools (MCP)" },
  { id: SECTION_IDS.experiments, label: "⚗ Experiments" },
];

export default function SettingsPage() {
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(
    SECTION_IDS.general,
  );
  const appVersion = useAppVersion();
  const { settings, updateSettings } = useSettings();
  const router = useRouter();
  const setActiveSettingsSection = useSetAtom(activeSettingsSectionAtom);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveSettingsSection(SECTION_IDS.general);
  }, [setActiveSettingsSection]);

  const scrollToSection = (id: string) => {
    setActiveSection(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleResetEverything = async () => {
    setIsResetting(true);
    try {
      await ipc.system.resetAll();
      showSuccess("Successfully reset everything. Restart the application.");
    } catch (error) {
      console.error("Error resetting:", error);
      showError(
        error instanceof Error ? error.message : "An unknown error occurred",
      );
    } finally {
      setIsResetting(false);
      setIsResetDialogOpen(false);
    }
  };

  return (
    <div className="settings-shell">
      {/* ── Left settings nav sidebar ── */}
      <aside className="settings-aside">
        <div className="head">⊙ Settings</div>
        {SETTINGS_NAV.map((nav) => (
          <button
            key={nav.id}
            className={`set-item ${activeSection === nav.id ? "active" : ""}`}
            onClick={() => scrollToSection(nav.id)}
            type="button"
          >
            {nav.label}
          </button>
        ))}
        <button
          className="set-item danger"
          onClick={() => scrollToSection(SECTION_IDS.dangerZone)}
          type="button"
        >
          ⚠ Danger Zone
        </button>
      </aside>

      {/* ── Right scrollable content ── */}
      <div className="settings-content" ref={contentRef}>
        <button
          className="back-link"
          onClick={() => router.history.back()}
          type="button"
        >
          ← Go Back
        </button>

        {/* General */}
        <GeneralSettings appVersion={appVersion} />

        {/* Workflow */}
        <WorkflowSettings />

        {/* AI */}
        <AISettings />

        {/* Model Providers */}
        <div id={SECTION_IDS.providers} className="glass set-section">
          <h2>▣ Model Providers</h2>
          <ProviderSettingsGrid />
        </div>

        {/* Telemetry */}
        <div id={SECTION_IDS.telemetry} className="glass set-section">
          <h2>📊 Telemetry</h2>
          <div className="set-row" id={SETTING_IDS.telemetry}>
            <TelemetrySwitch />
            <div className="desc" style={{ marginTop: 6 }}>
              Records anonymous usage data to improve the product.
            </div>
          </div>
          <div className="set-row">
            <span className="lbl">Telemetry ID</span>
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "rgba(168,140,255,.8)",
                marginTop: 4,
                display: "block",
              }}
            >
              {settings ? settings.telemetryUserId : "n/a"}
            </span>
          </div>
        </div>

        {/* Integrations */}
        <div id={SECTION_IDS.integrations} className="glass set-section">
          <h2>🔌 Integrations</h2>
          <div className="set-row" id={SETTING_IDS.github}>
            <GitHubIntegration />
          </div>
          <div className="set-row" id={SETTING_IDS.vercel}>
            <VercelIntegration />
          </div>
          <div className="set-row" id={SETTING_IDS.supabase}>
            <SupabaseIntegration />
          </div>
          <div className="set-row" id={SETTING_IDS.neon}>
            <NeonIntegration />
          </div>
          <div className="set-row" id={SETTING_IDS.braveSearch}>
            <BraveSearchSettings />
          </div>
        </div>

        {/* Agent Permissions */}
        <div id={SECTION_IDS.agentPermissions} className="glass set-section">
          <h2>🔐 Agent Permissions (Pro)</h2>
          <AgentToolsSettings />
        </div>

        {/* Tools MCP */}
        <div id={SECTION_IDS.toolsMcp} className="glass set-section">
          <h2>🛠 Tools (MCP)</h2>
          <ToolsMcpSettings />
        </div>

        {/* Experiments */}
        <div id={SECTION_IDS.experiments} className="glass set-section">
          <h2>⚗ Experiments</h2>
          <div className="set-row" id={SETTING_IDS.nativeGit}>
            <div className="row between">
              <div>
                <div className="lbl">Enable Native Git</div>
                <div className="desc">
                  Faster, native-Git performance — no external installation
                  required.
                </div>
              </div>
              <Switch
                id="enable-native-git"
                aria-label="Enable Native Git"
                checked={!!settings?.enableNativeGit}
                onCheckedChange={(checked) =>
                  updateSettings({ enableNativeGit: checked })
                }
              />
            </div>
          </div>
          <div className="set-row" id={SETTING_IDS.enableCloudSandbox}>
            <CloudSandboxExperimentSwitch />
          </div>
          <div className="set-row" id={SETTING_IDS.blockUnsafeNpmPackages}>
            <BlockUnsafeNpmPackagesSwitch />
          </div>
          <div
            className="set-row"
            id={SETTING_IDS.enableMcpServersForBuildMode}
          >
            <div className="row between">
              <div>
                <div className="lbl">Enable MCP servers for Build mode</div>
                <div className="desc">
                  MCP servers are always enabled in Agent mode.
                </div>
              </div>
              <Switch
                id="enable-mcp-servers-for-build-mode"
                aria-label="Enable MCP servers for Build mode"
                checked={!!settings?.enableMcpServersForBuildMode}
                onCheckedChange={(checked) =>
                  updateSettings({ enableMcpServersForBuildMode: checked })
                }
              />
            </div>
          </div>
          <div
            className="set-row"
            id={SETTING_IDS.enableSelectAppFromHomeChatInput}
          >
            <div className="row between">
              <div>
                <div className="lbl">
                  Enable Select App from Home Chat Input
                </div>
                <div className="desc">
                  Show an app selector in the home chat input.
                </div>
              </div>
              <Switch
                id="enable-select-app-from-home-chat-input"
                aria-label="Enable Select App from Home Chat Input"
                checked={!!settings?.enableSelectAppFromHomeChatInput}
                onCheckedChange={(checked) =>
                  updateSettings({ enableSelectAppFromHomeChatInput: checked })
                }
              />
            </div>
          </div>
        </div>

        {/* Danger Zone */}
        <div
          id={SECTION_IDS.dangerZone}
          className="glass set-section"
          style={{ borderColor: "rgba(255,80,90,.3)" }}
        >
          <h2 style={{ color: "#ff8794" }}>⚠ Danger Zone</h2>
          <div className="set-row" id={SETTING_IDS.reset}>
            <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
              <div>
                <div className="lbl">Reset Everything</div>
                <div className="desc">
                  Deletes all apps, chats, and settings. Cannot be undone.
                </div>
              </div>
              <button
                onClick={() => setIsResetDialogOpen(true)}
                disabled={isResetting}
                className="btn"
                style={{
                  background: "rgba(255,80,90,.18)",
                  borderColor: "rgba(255,80,90,.35)",
                  color: "#ff8794",
                }}
              >
                {isResetting ? "Resetting…" : "Reset Everything"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmationDialog
        isOpen={isResetDialogOpen}
        title="Reset Everything"
        message="Are you sure you want to reset everything? This will delete all your apps, chats, and settings. This action cannot be undone."
        confirmText={isResetting ? "Resetting..." : "Reset Everything"}
        cancelText="Cancel"
        confirmDisabled={isResetting}
        onConfirm={handleResetEverything}
        onCancel={() => setIsResetDialogOpen(false)}
      />
    </div>
  );
}

export function GeneralSettings({ appVersion }: { appVersion: string | null }) {
  const { theme, setTheme } = useTheme();

  return (
    <div id={SECTION_IDS.general} className="glass set-section">
      <h2>General Settings</h2>

      <div className="space-y-4 mb-4">
        <div id={SETTING_IDS.theme} className="flex items-center gap-4">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Theme
          </label>

          <div className="relative bg-gray-100 dark:bg-gray-700 rounded-lg p-1 flex">
            {(["system", "light", "dark"] as const).map((option) => (
              <button
                key={option}
                onClick={() => setTheme(option)}
                className={`
                px-4 py-1.5 text-sm font-medium rounded-md
                transition-all duration-200
                ${
                  theme === option
                    ? "bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm"
                    : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                }
              `}
              >
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <LanguageSelector />
      </div>

      <div id={SETTING_IDS.zoom} className="mt-4">
        <ZoomSelector />
      </div>

      <div id={SETTING_IDS.autoUpdate} className="space-y-1 mt-4">
        <AutoUpdateSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically update the app when new versions are
          available.
        </div>
      </div>

      <div id={SETTING_IDS.releaseChannel} className="mt-4">
        <ReleaseChannelSelector />
      </div>

      <div id={SETTING_IDS.runtimeMode} className="mt-4">
        <RuntimeModeSelector />
      </div>
      <div id={SETTING_IDS.nodePath} className="mt-4">
        <NodePathSelector />
      </div>
      <div id={SETTING_IDS.customAppsFolder} className="mt-4">
        <CustomAppsFolderSelector />
      </div>

      <div className="flex items-center text-sm text-gray-500 dark:text-gray-400 mt-4">
        <span className="mr-2 font-medium">App Version:</span>
        <span className="bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded text-gray-800 dark:text-gray-200 font-mono">
          {appVersion ? appVersion : "-"}
        </span>
      </div>
    </div>
  );
}

export function WorkflowSettings() {
  return (
    <div id={SECTION_IDS.workflow} className="glass set-section">
      <h2>Workflow Settings</h2>

      <div id={SETTING_IDS.defaultChatMode} className="mt-4">
        <DefaultChatModeSelector />
      </div>

      <div id={SETTING_IDS.autoApprove} className="space-y-1 mt-4">
        <AutoApproveSwitch showToast={false} />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically approve code changes and run them.
        </div>
      </div>

      <div id={SETTING_IDS.autoFix} className="space-y-1 mt-4">
        <AutoFixProblemsSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically fix TypeScript errors.
        </div>
      </div>

      <div id={SETTING_IDS.autoExpandPreview} className="space-y-1 mt-4">
        <AutoExpandPreviewSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Automatically expand the preview panel when code changes are made.
        </div>
      </div>

      <div id={SETTING_IDS.keepPreviewsRunning} className="space-y-1 mt-4">
        <KeepPreviewsRunningSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Note: this may take more memory but allows faster preview loads when
          switching apps.
        </div>
      </div>

      <div id={SETTING_IDS.chatEventNotification} className="space-y-1 mt-4">
        <ChatEventNotificationSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Show native notifications when a chat response completes or a
          questionnaire needs your input while the app is not focused.
        </div>
      </div>
    </div>
  );
}
export function AISettings() {
  return (
    <div id={SECTION_IDS.ai} className="glass set-section">
      <h2>AI Settings</h2>

      <div id={SETTING_IDS.thinkingBudget} className="mt-4">
        <ThinkingBudgetSelector />
      </div>

      <div id={SETTING_IDS.maxChatTurns} className="mt-4">
        <MaxChatTurnsSelector />
      </div>

      <div id={SETTING_IDS.maxToolCallSteps} className="mt-4">
        <MaxToolCallStepsSelector />
      </div>

      <div id={SETTING_IDS.contextCompaction} className="space-y-1 mt-4">
        <ContextCompactionSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Automatically compact long conversations to stay within context
          limits. Original messages are preserved in the app data directory.
        </div>
      </div>
    </div>
  );
}
