import {
  useUpdateCustomTheme,
  useDeleteCustomTheme,
} from "@/hooks/useCustomThemes";
import type { PromptItem } from "@/hooks/usePrompts";
import { Badge } from "@/components/ui/badge";
import { Palette, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreateOrEditPromptDialog } from "@/components/CreatePromptDialog";
import { DeleteConfirmationDialog } from "@/components/DeleteConfirmationDialog";
import { EditThemeDialog } from "@/components/EditThemeDialog";
import { showError } from "@/lib/toast";
import type { CustomTheme } from "@/ipc/types";

export type LibraryItem =
  | { type: "theme"; data: CustomTheme }
  | { type: "prompt"; data: PromptItem };

const CARD_TYPE_CONFIG = {
  theme: {
    icon: Palette,
    label: "Theme",
    badgeClass:
      "bg-primary/10 text-primary border-primary/20 backdrop-blur-md dark:bg-primary/20",
  },
  prompt: {
    icon: FileText,
    label: "Prompt",
    badgeClass:
      "bg-zinc-100 text-zinc-700 border-zinc-200 backdrop-blur-md dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700/50",
  },
} as const;

export function LibraryCard({
  item,
  onUpdatePrompt,
  onDeletePrompt,
}: {
  item: LibraryItem;
  onUpdatePrompt?: (p: {
    id: number;
    title: string;
    description?: string;
    content: string;
  }) => Promise<void>;
  onDeletePrompt?: (id: number) => Promise<void>;
}) {
  const config = CARD_TYPE_CONFIG[item.type];
  const Icon = config.icon;

  const title = item.type === "theme" ? item.data.name : item.data.title;
  const description = item.data.description;
  const content = item.type === "theme" ? item.data.prompt : item.data.content;
  const slug = item.type === "prompt" ? item.data.slug : null;

  return (
    <div
      data-testid={`library-${item.type}-card`}
      className="liquid-glass group relative rounded-[20px] border border-black/[0.06] bg-card/76 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.08)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_24px_56px_rgba(15,23,42,0.12)] dark:border-white/[0.08] dark:bg-card/72 dark:shadow-[0_18px_48px_rgba(0,0,0,0.32)] dark:hover:shadow-[0_24px_56px_rgba(0,0,0,0.4)]"
    >
      <Badge
        variant="outline"
        className={cn(
          "absolute top-3 right-3 gap-1 rounded-full",
          config.badgeClass,
        )}
      >
        <Icon className="h-3 w-3" />
        {config.label}
      </Badge>
      <div className="space-y-2">
        <div className="flex items-start justify-between pr-20">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <h3 className="truncate text-[17px] font-semibold">{title}</h3>
            </div>
            {description && (
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                {description}
              </p>
            )}
            {slug && (
              <p className="text-xs text-muted-foreground mt-1">
                Use <code className="font-mono">/{slug}</code> in chat
              </p>
            )}
          </div>
        </div>
        <pre className="max-h-48 overflow-auto rounded-2xl bg-secondary/34 p-3 text-sm whitespace-pre-wrap text-muted-foreground/90 transition-colors duration-200 group-hover:bg-secondary/50">
          {content}
        </pre>
        <div className="flex gap-1 justify-end">
          {item.type === "theme" ? (
            <ThemeActions theme={item.data} />
          ) : (
            onUpdatePrompt &&
            onDeletePrompt && (
              <PromptActions
                prompt={item.data}
                onUpdate={onUpdatePrompt}
                onDelete={onDeletePrompt}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function ThemeActions({ theme }: { theme: CustomTheme }) {
  const updateThemeMutation = useUpdateCustomTheme();
  const deleteThemeMutation = useDeleteCustomTheme();
  const isDeleting = deleteThemeMutation.isPending;

  const handleUpdate = async (params: {
    id: number;
    name: string;
    description?: string;
    prompt: string;
  }) => {
    await updateThemeMutation.mutateAsync(params);
  };

  const handleDelete = async () => {
    try {
      await deleteThemeMutation.mutateAsync(theme.id);
    } catch (error) {
      showError(
        `Failed to delete theme: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  return (
    <>
      <EditThemeDialog theme={theme} onUpdateTheme={handleUpdate} />
      <DeleteConfirmationDialog
        itemName={theme.name}
        itemType="Theme"
        onDelete={handleDelete}
        isDeleting={isDeleting}
      />
    </>
  );
}

function PromptActions({
  prompt,
  onUpdate,
  onDelete,
}: {
  prompt: PromptItem;
  onUpdate: (p: {
    id: number;
    title: string;
    description?: string;
    content: string;
  }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  return (
    <>
      <CreateOrEditPromptDialog
        mode="edit"
        prompt={prompt}
        onUpdatePrompt={onUpdate}
      />
      <DeleteConfirmationDialog
        itemName={prompt.title}
        itemType="Prompt"
        onDelete={() => onDelete(prompt.id)}
      />
    </>
  );
}
