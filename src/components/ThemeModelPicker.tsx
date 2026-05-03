import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Zap } from "lucide-react";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useEmbeddedModel } from "@/hooks/useEmbeddedModel";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { isDyadProEnabled, type LargeLanguageModel } from "@/lib/schemas";
import { TURBO_MODELS } from "@/ipc/shared/language_model_constants";
import { PriceBadge } from "@/components/PriceBadge";
import { cn } from "@/lib/utils";
import type { LocalModel } from "@/ipc/types";

interface ThemeModelPickerProps {
  value: LargeLanguageModel | null;
  onChange: (model: LargeLanguageModel) => void;
}

export function ThemeModelPicker({ value, onChange }: ThemeModelPickerProps) {
  const [open, setOpen] = useState(false);
  const { settings } = useSettings();

  const { data: modelsByProviders, isLoading: modelsByProvidersLoading } =
    useLanguageModelsByProviders();
  const { data: providers, isLoading: providersLoading } =
    useLanguageModelProviders();
  const loading = modelsByProvidersLoading || providersLoading;

  const {
    models: ollamaModels,
    loading: ollamaLoading,
    error: ollamaError,
    loadModels: loadOllamaModels,
  } = useLocalModels();

  const {
    models: lmStudioModels,
    loading: lmStudioLoading,
    error: lmStudioError,
    loadModels: loadLMStudioModels,
  } = useLocalLMSModels();

  const {
    status: embeddedStatus,
    loading: embeddedLoading,
    refresh: refreshEmbedded,
  } = useEmbeddedModel();

  useEffect(() => {
    if (open) {
      loadOllamaModels();
      loadLMStudioModels();
      refreshEmbedded();
    }
  }, [open, loadOllamaModels, loadLMStudioModels, refreshEmbedded]);

  // Auto-select embedded model on first render if nothing is selected
  useEffect(() => {
    if (value) return;
    if (embeddedStatus?.modelLoaded && embeddedStatus.modelName) {
      onChange({ name: embeddedStatus.modelName, provider: "embedded" });
    }
  }, [value, embeddedStatus, onChange]);

  const getDisplayName = (): string => {
    if (!value) return "Select model";
    if (value.provider === "embedded") {
      return embeddedStatus?.modelName ?? value.name;
    }
    if (value.provider === "ollama") {
      return (
        ollamaModels.find((m: LocalModel) => m.modelName === value.name)
          ?.displayName ?? value.name
      );
    }
    if (value.provider === "lmstudio") {
      return (
        lmStudioModels.find((m: LocalModel) => m.modelName === value.name)
          ?.displayName ?? value.name
      );
    }
    if (modelsByProviders?.[value.provider]) {
      const found = modelsByProviders[value.provider].find(
        (m) => m.apiName === value.name,
      );
      if (found) return found.displayName;
    }
    return value.name;
  };

  const select = (model: LargeLanguageModel) => {
    onChange(model);
    setOpen(false);
  };

  const hasOllamaModels =
    !ollamaLoading && !ollamaError && ollamaModels.length > 0;
  const hasLMStudioModels =
    !lmStudioLoading && !lmStudioError && lmStudioModels.length > 0;

  if (!settings) return null;

  const providerEntries =
    !loading && modelsByProviders
      ? Object.entries(modelsByProviders).filter(([id]) => id !== "auto")
      : [];

  const primaryProviders = providerEntries.filter(([id, models]) => {
    if (models.length === 0) return false;
    const p = providers?.find((p) => p.id === id);
    return !p?.secondary;
  });

  if (settings && isDyadProEnabled(settings)) {
    primaryProviders.unshift(["auto", TURBO_MODELS]);
  }

  const secondaryProviders = providerEntries.filter(([id, models]) => {
    if (models.length === 0) return false;
    const p = providers?.find((p) => p.id === id);
    return !!p?.secondary;
  });

  const autoModels =
    !loading && modelsByProviders?.["auto"]
      ? modelsByProviders["auto"].filter((m) => {
          if (
            !isDyadProEnabled(settings) &&
            ["turbo", "value"].includes(m.apiName)
          )
            return false;
          if (isDyadProEnabled(settings) && m.apiName === "free") return false;
          return true;
        })
      : [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        }
      >
        <span className="truncate text-left">{getDisplayName()}</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-64" align="start">
        {/* Local Models — top priority */}
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-yellow-500" />
          Local Models
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Embedded */}
        {embeddedStatus?.modelLoaded && embeddedStatus.modelName ? (
          <DropdownMenuItem
            className={value?.provider === "embedded" ? "bg-secondary" : ""}
            onClick={() =>
              select({ name: embeddedStatus.modelName!, provider: "embedded" })
            }
          >
            <div className="flex items-center gap-2 w-full">
              <Zap className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className="font-medium truncate">
                  {embeddedStatus.modelName}
                </span>
                <span className="text-xs text-green-600 dark:text-green-400">
                  Embedded · Tensor Cores
                </span>
              </div>
            </div>
          </DropdownMenuItem>
        ) : (
          <div className="px-2 py-2 text-sm">
            <div className="flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <div className="flex flex-col">
                <span
                  className={embeddedLoading ? "text-muted-foreground" : ""}
                >
                  {embeddedLoading ? "Checking…" : "Embedded (Tensor)"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {embeddedLoading
                    ? ""
                    : "No model loaded — go to Engine screen"}
                </span>
              </div>
            </div>
          </div>
        )}

        <DropdownMenuSeparator />

        {/* Ollama */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={ollamaLoading && !hasOllamaModels}
            className="w-full font-normal"
          >
            <div className="flex flex-col items-start">
              <span>Ollama</span>
              <span className="text-xs text-muted-foreground">
                {ollamaLoading
                  ? "Loading..."
                  : ollamaError
                    ? "Error loading"
                    : !hasOllamaModels
                      ? "None available"
                      : `${ollamaModels.length} models`}
              </span>
            </div>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56 max-h-96 overflow-y-auto">
            <DropdownMenuLabel>Ollama Models</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {ollamaLoading && ollamaModels.length === 0 ? (
              <div className="text-xs text-center py-2 text-muted-foreground">
                Loading…
              </div>
            ) : ollamaError ? (
              <div className="px-2 py-1.5 text-sm text-red-600">
                <span>Error loading models</span>
                <p className="text-xs text-muted-foreground">
                  Is Ollama running?
                </p>
              </div>
            ) : !hasOllamaModels ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                No models — ensure Ollama is running.
              </div>
            ) : (
              ollamaModels.map((m: LocalModel) => (
                <DropdownMenuItem
                  key={`ollama-${m.modelName}`}
                  className={
                    value?.provider === "ollama" && value.name === m.modelName
                      ? "bg-secondary"
                      : ""
                  }
                  onClick={() =>
                    select({ name: m.modelName, provider: "ollama" })
                  }
                >
                  <div className="flex flex-col">
                    <span>{m.displayName}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {m.modelName}
                    </span>
                  </div>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* LM Studio */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={lmStudioLoading && !hasLMStudioModels}
            className="w-full font-normal"
          >
            <div className="flex flex-col items-start">
              <span>LM Studio</span>
              <span className="text-xs text-muted-foreground">
                {lmStudioLoading
                  ? "Loading..."
                  : lmStudioError
                    ? "Error loading"
                    : !hasLMStudioModels
                      ? "None available"
                      : `${lmStudioModels.length} models`}
              </span>
            </div>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56 max-h-96 overflow-y-auto">
            <DropdownMenuLabel>LM Studio Models</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {lmStudioLoading && lmStudioModels.length === 0 ? (
              <div className="text-xs text-center py-2 text-muted-foreground">
                Loading…
              </div>
            ) : lmStudioError ? (
              <div className="px-2 py-1.5 text-sm text-red-600">
                <span>Error loading models</span>
                <p className="text-xs text-muted-foreground">
                  {lmStudioError.message}
                </p>
              </div>
            ) : !hasLMStudioModels ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                No models — ensure LM Studio is running.
              </div>
            ) : (
              lmStudioModels.map((m: LocalModel) => (
                <DropdownMenuItem
                  key={`lmstudio-${m.modelName}`}
                  className={
                    value?.provider === "lmstudio" && value.name === m.modelName
                      ? "bg-secondary"
                      : ""
                  }
                  onClick={() =>
                    select({ name: m.modelName, provider: "lmstudio" })
                  }
                >
                  <div className="flex flex-col">
                    <span>{m.displayName}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {m.modelName}
                    </span>
                  </div>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Cloud Models */}
        {(primaryProviders.length > 0 || secondaryProviders.length > 0) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Cloud Models</DropdownMenuLabel>
            <DropdownMenuSeparator />

            {/* Auto models */}
            {autoModels.map((m) => (
              <DropdownMenuItem
                key={`auto-${m.apiName}`}
                className={
                  value?.provider === "auto" && value.name === m.apiName
                    ? "bg-secondary"
                    : ""
                }
                onClick={() => select({ name: m.apiName, provider: "auto" })}
              >
                <div className="flex justify-between items-center w-full">
                  <span>{m.displayName}</span>
                  {m.tag && (
                    <span
                      className={cn(
                        "text-[11px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium",
                        m.tagColor,
                      )}
                    >
                      {m.tag}
                    </span>
                  )}
                </div>
              </DropdownMenuItem>
            ))}

            {/* Primary cloud providers */}
            {primaryProviders.map(([providerId, models]) => {
              const filtered = models.filter(
                (m) =>
                  !(isDyadProEnabled(settings) && m.apiName.endsWith(":free")),
              );
              const provider = providers?.find((p) => p.id === providerId);
              const name =
                providerId === "auto"
                  ? "OrianBuilder Turbo"
                  : (provider?.name ?? providerId);
              return (
                <DropdownMenuSub key={providerId}>
                  <DropdownMenuSubTrigger className="w-full font-normal">
                    <div className="flex flex-col items-start">
                      <span>{name}</span>
                      <span className="text-xs text-muted-foreground">
                        {filtered.length} models
                      </span>
                    </div>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56 max-h-96 overflow-y-auto">
                    <DropdownMenuLabel>{name} Models</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {filtered.map((m) => (
                      <DropdownMenuItem
                        key={`${providerId}-${m.apiName}`}
                        className={
                          value?.provider === providerId &&
                          value.name === m.apiName
                            ? "bg-secondary"
                            : ""
                        }
                        onClick={() =>
                          select({ name: m.apiName, provider: providerId })
                        }
                      >
                        <div className="flex justify-between items-center w-full">
                          <span>{m.displayName}</span>
                          <PriceBadge dollarSigns={m.dollarSigns} />
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}

            {/* Secondary providers */}
            {secondaryProviders.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="w-full font-normal">
                  <div className="flex flex-col items-start">
                    <span>Other AI providers</span>
                    <span className="text-xs text-muted-foreground">
                      {secondaryProviders.length} providers
                    </span>
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <DropdownMenuLabel>Other AI providers</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {secondaryProviders.map(([providerId, models]) => {
                    const provider = providers?.find(
                      (p) => p.id === providerId,
                    );
                    return (
                      <DropdownMenuSub key={providerId}>
                        <DropdownMenuSubTrigger className="w-full font-normal">
                          <span>{provider?.name ?? providerId}</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-56">
                          <DropdownMenuLabel>
                            {(provider?.name ?? providerId) + " Models"}
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {models.map((m) => (
                            <DropdownMenuItem
                              key={`${providerId}-${m.apiName}`}
                              className={
                                value?.provider === providerId &&
                                value.name === m.apiName
                                  ? "bg-secondary"
                                  : ""
                              }
                              onClick={() =>
                                select({
                                  name: m.apiName,
                                  provider: providerId,
                                })
                              }
                            >
                              <span>{m.displayName}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
