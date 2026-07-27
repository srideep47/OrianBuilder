import { useState, useMemo } from "react";
import { usePrompts } from "@/hooks/usePrompts";
import { useCustomThemes } from "@/hooks/useCustomThemes";
import { useAppMediaFiles } from "@/hooks/useAppMediaFiles";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useAddPromptDeepLink } from "@/hooks/useAddPromptDeepLink";
import { Loader2 } from "lucide-react";
import { CreateOrEditPromptDialog } from "@/components/CreatePromptDialog";
import { CustomThemeDialog } from "@/components/CustomThemeDialog";
import { NewLibraryItemMenu } from "@/components/NewLibraryItemMenu";
import { SpaceHeader } from "@/shell/SpaceHeader";
import { LibraryCard, type LibraryItem } from "@/components/LibraryCard";
import { LibrarySearchBar } from "@/components/LibrarySearchBar";
import {
  LibraryFilterTabs,
  type FilterType,
} from "@/components/LibraryFilterTabs";
import { OrianBuilderAppMediaFolder } from "@/components/OrianBuilderAppMediaFolder";
import { ImageGeneratorDialog } from "@/components/ImageGeneratorDialog";
import { ImageGenerationProgressButton } from "@/components/ImageGenerationProgressButton";
import { filterMediaAppsByQuery } from "@/lib/mediaUtils";
import { useGeneratedMedia } from "@/hooks/useGeneratedMedia";
import { GeneratedMediaCard } from "@/components/GeneratedMediaCard";
// ---------------------------------------------------------------------------
// Main Library Homepage
// ---------------------------------------------------------------------------

export default function LibraryHomePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterType>(() => {
    const params = new URLSearchParams(window.location.search);
    const filter = params.get("filter");
    if (filter === "themes" || filter === "prompts" || filter === "media")
      return filter;
    return "all";
  });

  const {
    prompts,
    isLoading: promptsLoading,
    createPrompt,
    updatePrompt,
    deletePrompt,
  } = usePrompts();
  const { customThemes, isLoading: themesLoading } = useCustomThemes();
  const {
    mediaApps,
    isLoading: mediaLoading,
    renameMediaFile,
    deleteMediaFile,
    moveMediaFile,
    isMutatingMedia,
  } = useAppMediaFiles();
  const { apps: allApps } = useLoadApps();
  const {
    items: generatedMedia,
    isLoading: generatedLoading,
    removeItem: removeGeneratedMedia,
    isMutating: isMutatingGenerated,
  } = useGeneratedMedia();
  const [createThemeDialogOpen, setCreateThemeDialogOpen] = useState(false);
  const [imageGeneratorOpen, setImageGeneratorOpen] = useState(false);

  // Deep link support
  const {
    prefillData,
    dialogOpen: promptDialogOpen,
    handleDialogClose: handlePromptDialogClose,
    setDialogOpen: setPromptDialogOpen,
  } = useAddPromptDeepLink();

  const isLoading =
    promptsLoading || themesLoading || mediaLoading || generatedLoading;

  const filteredItems = useMemo(() => {
    if (activeFilter === "media") return [];

    let items: LibraryItem[] = [];

    if (activeFilter === "all" || activeFilter === "themes") {
      items.push(
        ...customThemes.map((t) => ({ type: "theme" as const, data: t })),
      );
    }
    if (activeFilter === "all" || activeFilter === "prompts") {
      items.push(...prompts.map((p) => ({ type: "prompt" as const, data: p })));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter((item) => {
        if (item.type === "theme") {
          return (
            item.data.name.toLowerCase().includes(q) ||
            (item.data.description?.toLowerCase().includes(q) ?? false) ||
            item.data.prompt.toLowerCase().includes(q)
          );
        }
        return (
          item.data.title.toLowerCase().includes(q) ||
          (item.data.description?.toLowerCase().includes(q) ?? false) ||
          item.data.content.toLowerCase().includes(q)
        );
      });
    }

    // Sort by updatedAt descending
    items.sort((a, b) => {
      const dateA =
        a.data.updatedAt instanceof Date
          ? a.data.updatedAt
          : new Date(a.data.updatedAt);
      const dateB =
        b.data.updatedAt instanceof Date
          ? b.data.updatedAt
          : new Date(b.data.updatedAt);
      return dateB.getTime() - dateA.getTime();
    });

    return items;
  }, [customThemes, prompts, activeFilter, searchQuery]);

  const filteredMediaApps = useMemo(() => {
    if (activeFilter === "themes" || activeFilter === "prompts") return [];

    return filterMediaAppsByQuery(mediaApps, searchQuery);
  }, [mediaApps, activeFilter, searchQuery]);

  const filteredGeneratedMedia = useMemo(() => {
    if (activeFilter === "themes" || activeFilter === "prompts") return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return generatedMedia;
    return generatedMedia.filter(
      (m) =>
        (m.prompt?.toLowerCase().includes(q) ?? false) ||
        m.fileName.toLowerCase().includes(q),
    );
  }, [generatedMedia, activeFilter, searchQuery]);

  const hasNoResults =
    filteredItems.length === 0 &&
    filteredMediaApps.length === 0 &&
    filteredGeneratedMedia.length === 0;

  return (
    <div className="h-full w-full overflow-y-auto bg-transparent">
      <div className="mx-auto w-full max-w-[1440px] px-6 pb-8">
        <div className="flex flex-col gap-2">
          {/* Header. Was a 34px title — the biggest in the app — on a page that
              ranks the same as its siblings. */}
          <SpaceHeader
            description="Prompts, themes and generated media you own."
            actions={
              <>
                <ImageGenerationProgressButton />
                <NewLibraryItemMenu
                  onNewPrompt={() => setPromptDialogOpen(true)}
                  onNewTheme={() => setCreateThemeDialogOpen(true)}
                  onNewImage={() => setImageGeneratorOpen(true)}
                />
              </>
            }
          />

          {/* Dialogs (controlled externally) */}
          <CreateOrEditPromptDialog
            mode="create"
            onCreatePrompt={createPrompt}
            prefillData={prefillData}
            isOpen={promptDialogOpen}
            onOpenChange={handlePromptDialogClose}
            trigger={<span />}
          />

          <div className="-mb-1 flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
            <LibraryFilterTabs
              active={activeFilter}
              onChange={setActiveFilter}
            />
            <div className="w-full lg:w-[22rem]">
              <LibrarySearchBar value={searchQuery} onChange={setSearchQuery} />
            </div>
          </div>

          {/* Grid */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : hasNoResults ? (
            <div className="liquid-glass-thin rounded-[24px] border border-dashed border-black/[0.08] py-20 text-center text-muted-foreground dark:border-white/[0.1]">
              {searchQuery
                ? "No results found."
                : activeFilter === "media"
                  ? "No media files yet."
                  : activeFilter === "themes"
                    ? "No themes yet."
                    : activeFilter === "prompts"
                      ? "No prompts yet."
                      : "No items in your library yet."}
            </div>
          ) : (
            <div
              data-testid="library-grid"
              className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-5 lg:gap-6"
            >
              {filteredItems.map((item) => (
                <LibraryCard
                  key={`${item.type}-${item.data.id}`}
                  item={item}
                  onUpdatePrompt={updatePrompt}
                  onDeletePrompt={deletePrompt}
                />
              ))}
              {filteredMediaApps.map((app) => (
                <OrianBuilderAppMediaFolder
                  key={`media-${app.appId}`}
                  appId={app.appId}
                  appPath={app.appPath}
                  appName={app.appName}
                  files={app.files}
                  allApps={allApps}
                  onRenameMediaFile={renameMediaFile}
                  onDeleteMediaFile={deleteMediaFile}
                  onMoveMediaFile={moveMediaFile}
                  isMutatingMedia={isMutatingMedia}
                  searchQuery={searchQuery}
                />
              ))}
              {filteredGeneratedMedia.map((item) => (
                <GeneratedMediaCard
                  key={`generated-${item.fileName}`}
                  item={item}
                  onDelete={removeGeneratedMedia}
                  isMutating={isMutatingGenerated}
                />
              ))}
            </div>
          )}
        </div>

        <CustomThemeDialog
          open={createThemeDialogOpen}
          onOpenChange={setCreateThemeDialogOpen}
        />

        <ImageGeneratorDialog
          open={imageGeneratorOpen}
          onOpenChange={setImageGeneratorOpen}
        />
      </div>
    </div>
  );
}
