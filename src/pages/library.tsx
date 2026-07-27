import { BookMarked } from "lucide-react";
import { usePrompts } from "@/hooks/usePrompts";
import { useAddPromptDeepLink } from "@/hooks/useAddPromptDeepLink";
import { CreatePromptDialog } from "@/components/CreatePromptDialog";
import { LibraryCard } from "@/components/LibraryCard";
import { SpaceHeader } from "@/shell/SpaceHeader";
import {
  EmptyState,
  LBadge,
  LoadingState,
  PageShell,
} from "@/components/liquid";

/** Saved instructions you reuse across projects. */
export default function PromptsPage() {
  const { prompts, isLoading, createPrompt, updatePrompt, deletePrompt } =
    usePrompts();
  const { prefillData, dialogOpen, handleDialogClose } = useAddPromptDeepLink();

  return (
    <PageShell
      width="wide"
      header={
        <SpaceHeader
          meta={
            prompts.length > 0 ? (
              <LBadge tone="neutral">{prompts.length} saved</LBadge>
            ) : undefined
          }
          actions={
            <CreatePromptDialog
              onCreatePrompt={createPrompt}
              prefillData={prefillData}
              isOpen={dialogOpen}
              onOpenChange={handleDialogClose}
            />
          }
        />
      }
    >
      {isLoading ? (
        <LoadingState label="prompts" />
      ) : prompts.length === 0 ? (
        <EmptyState
          icon={<BookMarked />}
          title="No prompts yet"
          description="Save an instruction you keep retyping — a code style, a review checklist, a house tone — and it becomes one click in the composer."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {prompts.map((p) => (
            <LibraryCard
              key={p.id}
              item={{ type: "prompt", data: p }}
              onUpdatePrompt={updatePrompt}
              onDeletePrompt={deletePrompt}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
