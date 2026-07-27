import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  HardDrive,
  Network,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { ipc } from "@/ipc/types";
import type { ClaudeAvailability } from "@/ipc/types";
import type { LargeLanguageModel } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LBadge, material, radius } from "@/components/liquid";

/**
 * Who actually runs an Orion command.
 *
 * The command surface used to pick this up implicitly from `settings.selectedModel`
 * with nothing on screen to say so, which meant the single most consequential
 * choice on the page — local model, cloud model, a peer's GPU, or the Claude Code
 * CLI — was invisible and unchangeable without leaving for Settings.
 *
 * Claude Code appears here as a peer of the models rather than an entry in the
 * model list, because it isn't one: it's an agent that carries its own
 * Read/Write/Edit/Bash loop. Selecting it routes the command to that runtime
 * instead of through Orion's own planner.
 */

export type ExecutorKind = "model" | "claude-code";

export interface OrionExecutor {
  kind: ExecutorKind;
  /** Set when `kind === "model"`. */
  model?: LargeLanguageModel;
  /** Peer public key when the model runs on someone else's hardware. */
  peerId?: string;
  label: string;
  sublabel: string;
}

const CLAUDE_CODE_EXECUTOR: OrionExecutor = {
  kind: "claude-code",
  label: "Claude Code",
  sublabel: "The real CLI, on your subscription",
};

export function OrionExecutorPicker({
  value,
  onChange,
  className,
}: {
  value: OrionExecutor | null;
  onChange: (executor: OrionExecutor) => void;
  className?: string;
}) {
  const { settings, updateSettings } = useSettings();
  const [open, setOpen] = useState(false);
  const [claude, setClaude] = useState<ClaudeAvailability | null>(null);
  const [peers, setPeers] = useState<
    Array<{ publicKey: string; displayName: string; deviceName: string }>
  >([]);

  const { data: providerModels } = useLanguageModelsByProviders();

  useEffect(() => {
    void ipc.claudeCode
      .detect(undefined)
      .then(setClaude)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void ipc.network
      .getStatus(undefined)
      .then((status) =>
        setPeers(
          (status.peers ?? [])
            .filter((p) => p.isTrusted && p.status === "online")
            .map((p) => ({
              publicKey: p.publicKey,
              displayName: p.displayName,
              deviceName: p.deviceName,
            })),
        ),
      )
      .catch(() => setPeers([]));
  }, []);

  /**
   * Grouped by where the work happens, not by vendor. "Which machine pays for
   * this" is the distinction that changes the user's decision; the vendor name is
   * detail inside it.
   */
  const groups = useMemo(() => {
    const local: OrionExecutor[] = [];
    const cloud: OrionExecutor[] = [];

    for (const [provider, models] of Object.entries(providerModels ?? {})) {
      for (const model of models) {
        const executor: OrionExecutor = {
          kind: "model",
          model: { name: model.apiName, provider },
          label: model.displayName ?? model.apiName,
          sublabel: provider,
        };
        if (
          provider === "embedded" ||
          provider === "ollama" ||
          provider === "lmstudio"
        ) {
          local.push(executor);
        } else {
          cloud.push(executor);
        }
      }
    }

    const peerExecutors: OrionExecutor[] = peers.map((peer) => ({
      kind: "model",
      // A peer runs its own resident model; the name is resolved on their side.
      model: { name: "peer", provider: "peer" },
      peerId: peer.publicKey,
      label: peer.displayName,
      sublabel: peer.deviceName,
    }));

    return { local, cloud, peers: peerExecutors };
  }, [providerModels, peers]);

  // Seed from the persisted selection so the pill reflects what would actually
  // run if the user pressed send without touching this.
  useEffect(() => {
    if (value || !settings) return;
    const selected = settings.selectedModel;
    if (selected) {
      onChange({
        kind: "model",
        model: selected,
        label: selected.name,
        sublabel: selected.provider,
      });
    }
  }, [settings, value, onChange]);

  const select = (executor: OrionExecutor) => {
    onChange(executor);
    setOpen(false);
    // Persist model choices so the rest of the app agrees with this picker.
    // Claude Code is a routing decision for this surface, not a global model.
    if (executor.kind === "model" && executor.model && !executor.peerId) {
      void updateSettings({ selectedModel: executor.model });
    }
  };

  const active = value ?? CLAUDE_CODE_EXECUTOR;
  const Icon =
    active.kind === "claude-code"
      ? Terminal
      : active.peerId
        ? Network
        : active.sublabel === "embedded"
          ? HardDrive
          : Cloud;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Choose who runs this command"
        className={cn(
          "inline-flex h-8 max-w-[240px] shrink-0 items-center gap-1.5 px-2.5 text-[12px] font-medium outline-none",
          radius.pill,
          material.fill,
          material.rim,
          "text-foreground/85 transition-colors hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-primary/45",
          className,
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate">{active.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={8}
        className="max-h-[440px] w-[340px] overflow-y-auto p-1.5"
      >
        <Group label="Agent" hint="Brings its own tools">
          <Row
            icon={<Terminal />}
            label={CLAUDE_CODE_EXECUTOR.label}
            sublabel={
              claude?.available
                ? (claude.version ?? CLAUDE_CODE_EXECUTOR.sublabel)
                : "not installed — run `claude` once to sign in"
            }
            selected={active.kind === "claude-code"}
            disabled={!claude?.available}
            onSelect={() => select(CLAUDE_CODE_EXECUTOR)}
            badge={
              claude?.available ? (
                <LBadge tone="success">subscription</LBadge>
              ) : (
                <LBadge tone="warning">missing</LBadge>
              )
            }
          />
        </Group>

        {groups.local.length > 0 && (
          <Group label="This machine" hint="No tokens, no network">
            {groups.local.map((executor) => (
              <Row
                key={`${executor.model?.provider}:${executor.model?.name}`}
                icon={<HardDrive />}
                label={executor.label}
                sublabel={executor.sublabel}
                selected={
                  active.kind === "model" &&
                  !active.peerId &&
                  active.model?.name === executor.model?.name &&
                  active.model?.provider === executor.model?.provider
                }
                onSelect={() => select(executor)}
              />
            ))}
          </Group>
        )}

        {groups.peers.length > 0 && (
          <Group label="Trusted peers" hint="Runs on their GPU">
            {groups.peers.map((executor) => (
              <Row
                key={executor.peerId}
                icon={<Network />}
                label={executor.label}
                sublabel={executor.sublabel}
                selected={active.peerId === executor.peerId}
                onSelect={() => select(executor)}
              />
            ))}
          </Group>
        )}

        {groups.cloud.length > 0 && (
          <Group label="Cloud" hint="Billed per token">
            {groups.cloud.map((executor) => (
              <Row
                key={`${executor.model?.provider}:${executor.model?.name}`}
                icon={<Cloud />}
                label={executor.label}
                sublabel={executor.sublabel}
                selected={
                  active.kind === "model" &&
                  !active.peerId &&
                  active.model?.name === executor.model?.name &&
                  active.model?.provider === executor.model?.provider
                }
                onSelect={() => select(executor)}
              />
            ))}
          </Group>
        )}

        {groups.local.length === 0 &&
          groups.cloud.length === 0 &&
          !claude?.available && (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              No executor available yet. Install a local model on the Engine
              page, add a cloud provider key in Settings, or install the Claude
              Code CLI.
            </p>
          )}
      </PopoverContent>
    </Popover>
  );
}

function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <div className="flex items-baseline gap-2 px-2.5 pb-1 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        <span className="truncate text-[11px] text-muted-foreground/70">
          {hint}
        </span>
      </div>
      {children}
    </div>
  );
}

function Row({
  icon,
  label,
  sublabel,
  selected,
  disabled,
  onSelect,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  badge?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left outline-none transition-colors",
        selected ? "bg-primary/15" : "hover:bg-white/[0.06]",
        disabled && "cursor-not-allowed opacity-55",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] [&_svg]:h-3.5 [&_svg]:w-3.5",
          selected
            ? "bg-primary/20 text-primary"
            : "bg-white/[0.07] text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px] font-medium",
            selected ? "text-primary" : "text-foreground",
          )}
        >
          {label}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {sublabel}
        </span>
      </span>
      {badge}
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
    </button>
  );
}

export { CLAUDE_CODE_EXECUTOR };
export const EXECUTOR_ICONS = { Cpu, Sparkles };
