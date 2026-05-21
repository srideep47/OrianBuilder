import {
  isOrianBuilderProEnabled,
  type LargeLanguageModel,
} from "@/lib/schemas";
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
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useEmbeddedModelStatus } from "@/hooks/useEmbeddedModelStatus";
import {
  buildEmbeddedModelConfigForPath,
  useEmbeddedModelSwap,
} from "@/hooks/useEmbeddedModelSwap";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { Loader2, Wifi, Zap } from "lucide-react";
import { queryKeys } from "@/lib/queryKeys";

import { ipc, LocalModel, type LocalModelEntry } from "@/ipc/types";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { PriceBadge } from "@/components/PriceBadge";
import { TURBO_MODELS } from "@/ipc/shared/language_model_constants";
import { cn } from "@/lib/utils";
import { showError } from "@/lib/toast";
import type { ComputeNode, ComputeTarget } from "@/ipc/types/compute";

export function ModelPicker() {
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const [isModelSwitching, setIsModelSwitching] = useState(false);
  const onModelSelect = async (
    model: LargeLanguageModel,
    opts?: { routeToPeerId?: string },
  ) => {
    if (
      embeddedStatus?.isInferring &&
      (model.provider === "embedded" || embeddedStatus.modelLoaded)
    ) {
      showError("Cannot swap during active inference");
      return;
    }

    setIsModelSwitching(true);
    try {
      if (model.provider !== "embedded" && embeddedStatus?.modelLoaded) {
        const result = await unloadModel();
        if (!result.success) {
          showError(result.error ?? "Failed to unload embedded model");
          return;
        }
      }

      // Route compute to the peer that owns this model, or reset to local
      if (opts?.routeToPeerId) {
        setComputeTarget.mutate({ mode: "peer", peerId: opts.routeToPeerId });
      } else if (computeTarget?.mode === "peer") {
        setComputeTarget.mutate({ mode: "local" });
      }

      await updateSettings({ selectedModel: model });
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      setIsModelSwitching(false);
    }

    queryClient.invalidateQueries({ queryKey: queryKeys.tokenCount.all });
  };

  const [open, setOpen] = useState(false);

  // Compute routing state
  const { data: computeTarget } = useQuery<ComputeTarget>({
    queryKey: queryKeys.compute.target,
    queryFn: () => ipc.compute.getTarget(),
  });
  const { data: computeNodes = [] } = useQuery<ComputeNode[]>({
    queryKey: queryKeys.compute.nodes,
    queryFn: () => ipc.compute.getAvailableNodes(),
    refetchInterval: open ? 3000 : 30000,
  });

  // All remote (non-local) peers — shown in dropdown regardless of model state
  const peerNodes = computeNodes.filter((n) => !n.isLocal);

  const activePeerNode =
    computeTarget?.mode === "peer" && computeTarget.peerId
      ? (computeNodes.find((n) => n.id === computeTarget.peerId) ?? null)
      : null;

  const setComputeTarget = useMutation({
    mutationFn: (params: { mode: "local" | "peer"; peerId?: string }) =>
      ipc.compute.setTarget(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.compute.target });
      queryClient.invalidateQueries({ queryKey: queryKeys.compute.nodes });
    },
  });

  // Cloud models from providers
  const { data: modelsByProviders, isLoading: modelsByProvidersLoading } =
    useLanguageModelsByProviders();

  const { data: providers, isLoading: providersLoading } =
    useLanguageModelProviders();

  const loading = modelsByProvidersLoading || providersLoading;
  // Ollama Models Hook
  const {
    models: ollamaModels,
    loading: ollamaLoading,
    error: ollamaError,
    loadModels: loadOllamaModels,
  } = useLocalModels();

  // LM Studio Models Hook
  const {
    models: lmStudioModels,
    loading: lmStudioLoading,
    error: lmStudioError,
    loadModels: loadLMStudioModels,
  } = useLocalLMSModels();

  // Embedded model hook
  const {
    data: embeddedStatus,
    isLoading: embeddedLoading,
    refetch: refreshEmbedded,
  } = useEmbeddedModelStatus();
  const { swapModel, unloadModel, isSwapping } = useEmbeddedModelSwap();
  const [embeddedLibrary, setEmbeddedLibrary] = useState<LocalModelEntry[]>([]);

  const loadEmbeddedLibrary = useCallback(async () => {
    try {
      setEmbeddedLibrary(await ipc.marketplace.listLocalModels(undefined));
    } catch {
      setEmbeddedLibrary([]);
    }
  }, []);

  // Load models when the dropdown opens
  useEffect(() => {
    if (open) {
      loadOllamaModels();
      loadLMStudioModels();
      void refreshEmbedded();
      void loadEmbeddedLibrary();
    }
  }, [
    open,
    loadOllamaModels,
    loadLMStudioModels,
    refreshEmbedded,
    loadEmbeddedLibrary,
  ]);

  const onEmbeddedModelSelect = async (entry: LocalModelEntry) => {
    if (embeddedStatus?.isInferring) {
      showError("Cannot swap during active inference");
      return;
    }

    setIsModelSwitching(true);
    try {
      const config = await buildEmbeddedModelConfigForPath(entry.filePath);
      await swapModel(config);
      await updateSettings({
        selectedModel: {
          name: entry.fileName,
          provider: "embedded",
        },
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.tokenCount.all });
      setOpen(false);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsModelSwitching(false);
    }
  };

  // Get display name for the selected model
  const getModelDisplayName = () => {
    if (selectedModel.provider === "ollama") {
      return (
        ollamaModels.find(
          (model: LocalModel) => model.modelName === selectedModel.name,
        )?.displayName || selectedModel.name
      );
    }
    if (selectedModel.provider === "lmstudio") {
      return (
        lmStudioModels.find(
          (model: LocalModel) => model.modelName === selectedModel.name,
        )?.displayName || selectedModel.name
      );
    }
    if (selectedModel.provider === "embedded") {
      return embeddedStatus?.modelName ?? selectedModel.name;
    }

    // For cloud models, look up in the modelsByProviders data
    if (modelsByProviders && modelsByProviders[selectedModel.provider]) {
      const customFoundModel = modelsByProviders[selectedModel.provider].find(
        (model) =>
          model.type === "custom" && model.id === selectedModel.customModelId,
      );
      if (customFoundModel) {
        return customFoundModel.displayName;
      }
      const foundModel = modelsByProviders[selectedModel.provider].find(
        (model) => model.apiName === selectedModel.name,
      );
      if (foundModel) {
        return foundModel.displayName;
      }
    }

    // Fallback if not found
    return selectedModel.name;
  };

  // Get auto provider models (if any)
  const autoModels =
    !loading && modelsByProviders && modelsByProviders["auto"]
      ? modelsByProviders["auto"].filter((model) => {
          if (
            settings &&
            !isOrianBuilderProEnabled(settings) &&
            ["turbo", "value"].includes(model.apiName)
          ) {
            return false;
          }
          if (
            settings &&
            isOrianBuilderProEnabled(settings) &&
            model.apiName === "free"
          ) {
            return false;
          }
          return true;
        })
      : [];

  // Determine availability of local models
  const hasOllamaModels =
    !ollamaLoading && !ollamaError && ollamaModels.length > 0;
  const hasLMStudioModels =
    !lmStudioLoading && !lmStudioError && lmStudioModels.length > 0;

  if (!settings) {
    return null;
  }
  const selectedModel = settings?.selectedModel;
  const modelDisplayName = getModelDisplayName();
  // Split providers into primary and secondary groups (excluding auto)
  const providerEntries =
    !loading && modelsByProviders
      ? Object.entries(modelsByProviders).filter(
          ([providerId]) => providerId !== "auto",
        )
      : [];
  const primaryProviders = providerEntries.filter(([providerId, models]) => {
    if (models.length === 0) return false;
    const provider = providers?.find((p) => p.id === providerId);
    return !(provider && provider.secondary);
  });
  if (settings && isOrianBuilderProEnabled(settings)) {
    primaryProviders.unshift(["auto", TURBO_MODELS]);
  }
  const secondaryProviders = providerEntries.filter(([providerId, models]) => {
    if (models.length === 0) return false;
    const provider = providers?.find((p) => p.id === providerId);
    return !!(provider && provider.secondary);
  });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border-none shadow-none h-7 max-w-[220px] px-2 gap-1.5 cursor-pointer",
          activePeerNode
            ? "bg-primary/10 text-primary hover:bg-primary/20"
            : "bg-transparent text-foreground/80 hover:text-foreground hover:bg-muted/60",
        )}
        data-testid="model-picker"
        title={
          activePeerNode
            ? `${modelDisplayName} — running on ${activePeerNode.label.split(" · ")[0]}`
            : modelDisplayName
        }
      >
        {activePeerNode ? (
          <>
            <Wifi className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              {activePeerNode.label.split(" · ")[0]}
            </span>
            <span className="text-primary/50">›</span>
            <span className="truncate max-w-[70px]">{modelDisplayName}</span>
          </>
        ) : (
          <span className="truncate">
            {modelDisplayName === "Auto" && (
              <span className="text-xs text-muted-foreground/70">Model: </span>
            )}
            {modelDisplayName}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start">
        <DropdownMenuLabel>Cloud Models</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {loading ? (
          <div className="text-xs text-center py-2 text-muted-foreground">
            Loading models...
          </div>
        ) : !modelsByProviders ||
          Object.keys(modelsByProviders).length === 0 ? (
          <div className="text-xs text-center py-2 text-muted-foreground">
            No cloud models available
          </div>
        ) : (
          /* Cloud models loaded */
          <>
            {/* Auto models at top level if any */}
            {autoModels.length > 0 && (
              <>
                {autoModels.map((model) => (
                  <DropdownMenuItem
                    key={`auto-${model.apiName}`}
                    title={model.description}
                    className={
                      selectedModel.provider === "auto" &&
                      selectedModel.name === model.apiName
                        ? "bg-secondary"
                        : ""
                    }
                    onClick={() => {
                      onModelSelect({
                        name: model.apiName,
                        provider: "auto",
                      });
                      setOpen(false);
                    }}
                  >
                    <div className="flex justify-between items-start w-full">
                      <span className="flex flex-col items-start">
                        <span>{model.displayName}</span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        {model.tag && (
                          <span
                            className={cn(
                              "text-[11px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium",
                              model.tagColor,
                            )}
                          >
                            {model.tag}
                          </span>
                        )}
                      </div>
                    </div>
                  </DropdownMenuItem>
                ))}
                {Object.keys(modelsByProviders).length > 1 && (
                  <DropdownMenuSeparator />
                )}
              </>
            )}

            {/* Primary providers as submenus */}
            {primaryProviders.map(([providerId, models]) => {
              models = models.filter((model) => {
                // Don't show free models if OrianBuilder Pro is enabled because
                // we will use the paid models (in OrianBuilder Pro backend) which
                // don't have the free limitations.
                if (
                  isOrianBuilderProEnabled(settings) &&
                  model.apiName.endsWith(":free")
                ) {
                  return false;
                }
                return true;
              });
              const provider = providers?.find((p) => p.id === providerId);
              const providerDisplayName =
                provider?.id === "auto"
                  ? "OrianBuilder Turbo"
                  : (provider?.name ?? providerId);
              return (
                <DropdownMenuSub key={providerId}>
                  <DropdownMenuSubTrigger className="w-full font-normal">
                    <div className="flex flex-col items-start w-full">
                      <div className="flex items-center gap-2">
                        <span>{providerDisplayName}</span>
                        {provider?.type === "custom" && (
                          <span className="text-[10px] bg-amber-500/20 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                            Custom
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {models.length} models
                      </span>
                    </div>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56 max-h-100 overflow-y-auto">
                    <DropdownMenuLabel>
                      {providerDisplayName + " Models"}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {models.map((model) => (
                      <DropdownMenuItem
                        key={`${providerId}-${model.apiName}`}
                        title={model.description}
                        className={
                          selectedModel.provider === providerId &&
                          selectedModel.name === model.apiName
                            ? "bg-secondary"
                            : ""
                        }
                        onClick={() => {
                          const customModelId =
                            model.type === "custom" ? model.id : undefined;
                          onModelSelect({
                            name: model.apiName,
                            provider: providerId,
                            customModelId,
                          });
                          setOpen(false);
                        }}
                      >
                        <div className="flex justify-between items-start w-full">
                          <span>{model.displayName}</span>
                          <PriceBadge dollarSigns={model.dollarSigns} />
                          {model.tag && (
                            <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                              {model.tag}
                            </span>
                          )}
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}

            {/* Secondary providers grouped under Other AI providers */}
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
                          <div className="flex flex-col items-start w-full">
                            <div className="flex items-center gap-2">
                              <span>{provider?.name ?? providerId}</span>
                              {provider?.type === "custom" && (
                                <span className="text-[10px] bg-amber-500/20 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                                  Custom
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {models.length} models
                            </span>
                          </div>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-56">
                          <DropdownMenuLabel>
                            {(provider?.name ?? providerId) + " Models"}
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {models.map((model) => (
                            <DropdownMenuItem
                              key={`${providerId}-${model.apiName}`}
                              title={model.description}
                              className={
                                selectedModel.provider === providerId &&
                                selectedModel.name === model.apiName
                                  ? "bg-secondary"
                                  : ""
                              }
                              onClick={() => {
                                const customModelId =
                                  model.type === "custom"
                                    ? model.id
                                    : undefined;
                                onModelSelect({
                                  name: model.apiName,
                                  provider: providerId,
                                  customModelId,
                                });
                                setOpen(false);
                              }}
                            >
                              <div className="flex justify-between items-start w-full">
                                <span>{model.displayName}</span>
                                {model.tag && (
                                  <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                                    {model.tag}
                                  </span>
                                )}
                              </div>
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

        {/* Network Devices — all connected peers */}
        {peerNodes.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-primary">
              <Wifi className="w-3.5 h-3.5" />
              Network Devices
            </DropdownMenuLabel>
            {peerNodes.map((node) => {
              const isActive = activePeerNode?.id === node.id;
              const hasModels = node.loadedModels.length > 0;
              const gpuLabel =
                node.hardware?.gpu && node.hardware.gpu !== "Unknown"
                  ? node.hardware.gpu
                      .replace("NVIDIA GeForce ", "")
                      .replace("AMD Radeon ", "")
                  : null;
              return (
                <DropdownMenuSub key={`peer-${node.id}`}>
                  <DropdownMenuSubTrigger
                    className={cn(
                      "w-full font-normal",
                      isActive && "bg-primary/10",
                    )}
                  >
                    <div className="flex flex-col items-start w-full gap-0.5">
                      <div className="flex items-center gap-2 w-full">
                        <Wifi
                          className={cn(
                            "w-3.5 h-3.5 shrink-0",
                            isActive ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                        <span className="flex-1 truncate">
                          {node.label.split(" · ")[0]}
                        </span>
                        {isActive && (
                          <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium shrink-0">
                            Active
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground pl-5">
                        {hasModels ? (
                          <>
                            {node.loadedModels.length} model
                            {node.loadedModels.length !== 1 ? "s" : ""}
                            {gpuLabel && <> · {gpuLabel}</>}
                          </>
                        ) : (
                          "No Ollama models — start Ollama on that device"
                        )}
                      </span>
                    </div>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-64">
                    <DropdownMenuLabel className="flex items-center gap-1.5 text-xs">
                      <Wifi className="w-3.5 h-3.5 text-primary" />
                      {node.label.split(" · ")[0]}
                      {gpuLabel && (
                        <span className="text-muted-foreground font-normal">
                          · {gpuLabel}
                        </span>
                      )}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {hasModels ? (
                      node.loadedModels.map((modelName) => {
                        const isSelectedOnThisPeer =
                          isActive &&
                          selectedModel.provider === "ollama" &&
                          selectedModel.name === modelName;
                        return (
                          <DropdownMenuItem
                            key={`${node.id}-${modelName}`}
                            className={
                              isSelectedOnThisPeer ? "bg-secondary" : ""
                            }
                            onClick={() => {
                              void onModelSelect(
                                { name: modelName, provider: "ollama" },
                                { routeToPeerId: node.id },
                              );
                              setOpen(false);
                            }}
                          >
                            <div className="flex items-center gap-2 w-full">
                              <Wifi className="w-3 h-3 text-primary/60 shrink-0" />
                              <span className="truncate">{modelName}</span>
                            </div>
                          </DropdownMenuItem>
                        );
                      })
                    ) : (
                      <div className="px-3 py-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground mb-1">
                          No models found
                        </p>
                        <p>
                          Make sure Ollama is running on that device and has at
                          least one model pulled.
                        </p>
                        <p className="mt-1 font-mono text-[10px]">
                          ollama pull llama3
                        </p>
                      </div>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
          </>
        )}

        <>
          <DropdownMenuSeparator />
          {/* Local Models Parent SubMenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="w-full font-normal">
              <div className="flex flex-col items-start">
                <span>Local models</span>
                <span className="text-xs text-muted-foreground">
                  Embedded, LM Studio, Ollama
                </span>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {/* Embedded (Tensor) Model — always shown at top */}
              {embeddedStatus?.isInferring && (
                <div className="px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  Cannot swap during active inference
                </div>
              )}
              {embeddedStatus?.modelLoaded && embeddedStatus.modelName ? (
                <DropdownMenuItem
                  className={
                    selectedModel.provider === "embedded" ? "bg-secondary" : ""
                  }
                  disabled={embeddedStatus.isInferring || isModelSwitching}
                  onClick={() => {
                    void onModelSelect({
                      name: embeddedStatus.modelName!,
                      provider: "embedded",
                    });
                    setOpen(false);
                  }}
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
                        className={
                          embeddedLoading ? "text-muted-foreground" : ""
                        }
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
              {embeddedLibrary
                .filter((entry) => entry.filePath !== embeddedStatus?.modelPath)
                .map((entry) => (
                  <DropdownMenuItem
                    key={`embedded-${entry.filePath}`}
                    className={
                      selectedModel.provider === "embedded" &&
                      selectedModel.name === entry.fileName
                        ? "bg-secondary"
                        : ""
                    }
                    disabled={
                      embeddedStatus?.isInferring ||
                      isModelSwitching ||
                      isSwapping
                    }
                    onClick={() => {
                      void onEmbeddedModelSelect(entry);
                    }}
                    title={entry.filePath}
                  >
                    <div className="flex items-center gap-2 w-full min-w-0">
                      {isModelSwitching || isSwapping ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground shrink-0" />
                      ) : (
                        <Zap className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium truncate">
                          {entry.fileName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Embedded GGUF
                        </span>
                      </div>
                    </div>
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />

              {/* Ollama Models SubMenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={ollamaLoading && !hasOllamaModels} // Disable if loading and no models yet
                  className="w-full font-normal"
                >
                  <div className="flex flex-col items-start">
                    <span>Ollama</span>
                    {ollamaLoading ? (
                      <span className="text-xs text-muted-foreground">
                        Loading...
                      </span>
                    ) : ollamaError ? (
                      <span className="text-xs text-red-500">
                        Error loading
                      </span>
                    ) : !hasOllamaModels ? (
                      <span className="text-xs text-muted-foreground">
                        None available
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {ollamaModels.length} models
                      </span>
                    )}
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56 max-h-100 overflow-y-auto">
                  <DropdownMenuLabel>Ollama Models</DropdownMenuLabel>
                  <DropdownMenuSeparator />

                  {ollamaLoading && ollamaModels.length === 0 ? ( // Show loading only if no models are loaded yet
                    <div className="text-xs text-center py-2 text-muted-foreground">
                      Loading models...
                    </div>
                  ) : ollamaError ? (
                    <div className="px-2 py-1.5 text-sm text-red-600">
                      <div className="flex flex-col">
                        <span>Error loading models</span>
                        <span className="text-xs text-muted-foreground">
                          Is Ollama running?
                        </span>
                      </div>
                    </div>
                  ) : !hasOllamaModels ? (
                    <div className="px-2 py-1.5 text-sm">
                      <div className="flex flex-col">
                        <span>No local models found</span>
                        <span className="text-xs text-muted-foreground">
                          Ensure Ollama is running and models are pulled.
                        </span>
                      </div>
                    </div>
                  ) : (
                    ollamaModels.map((model: LocalModel) => (
                      <DropdownMenuItem
                        key={`ollama-${model.modelName}`}
                        className={
                          selectedModel.provider === "ollama" &&
                          selectedModel.name === model.modelName
                            ? "bg-secondary"
                            : ""
                        }
                        onClick={() => {
                          onModelSelect({
                            name: model.modelName,
                            provider: "ollama",
                          });
                          setOpen(false);
                        }}
                      >
                        <div className="flex flex-col">
                          <span>{model.displayName}</span>
                          <span className="text-xs text-muted-foreground truncate">
                            {model.modelName}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              {/* LM Studio Models SubMenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={lmStudioLoading && !hasLMStudioModels} // Disable if loading and no models yet
                  className="w-full font-normal"
                >
                  <div className="flex flex-col items-start">
                    <span>LM Studio</span>
                    {lmStudioLoading ? (
                      <span className="text-xs text-muted-foreground">
                        Loading...
                      </span>
                    ) : lmStudioError ? (
                      <span className="text-xs text-red-500">
                        Error loading
                      </span>
                    ) : !hasLMStudioModels ? (
                      <span className="text-xs text-muted-foreground">
                        None available
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {lmStudioModels.length} models
                      </span>
                    )}
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56 max-h-100 overflow-y-auto">
                  <DropdownMenuLabel>LM Studio Models</DropdownMenuLabel>
                  <DropdownMenuSeparator />

                  {lmStudioLoading && lmStudioModels.length === 0 ? ( // Show loading only if no models are loaded yet
                    <div className="text-xs text-center py-2 text-muted-foreground">
                      Loading models...
                    </div>
                  ) : lmStudioError ? (
                    <div className="px-2 py-1.5 text-sm text-red-600">
                      <div className="flex flex-col">
                        <span>Error loading models</span>
                        <span className="text-xs text-muted-foreground">
                          {lmStudioError.message} {/* Display specific error */}
                        </span>
                      </div>
                    </div>
                  ) : !hasLMStudioModels ? (
                    <div className="px-2 py-1.5 text-sm">
                      <div className="flex flex-col">
                        <span>No loaded models found</span>
                        <span className="text-xs text-muted-foreground">
                          Ensure LM Studio is running and models are loaded.
                        </span>
                      </div>
                    </div>
                  ) : (
                    lmStudioModels.map((model: LocalModel) => (
                      <DropdownMenuItem
                        key={`lmstudio-${model.modelName}`}
                        className={
                          selectedModel.provider === "lmstudio" &&
                          selectedModel.name === model.modelName
                            ? "bg-secondary"
                            : ""
                        }
                        onClick={() => {
                          onModelSelect({
                            name: model.modelName,
                            provider: "lmstudio",
                          });
                          setOpen(false);
                        }}
                      >
                        <div className="flex flex-col">
                          {/* Display the user-friendly name */}
                          <span>{model.displayName}</span>
                          {/* Show the path as secondary info */}
                          <span className="text-xs text-muted-foreground truncate">
                            {model.modelName}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
