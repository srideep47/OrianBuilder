import { usePrompts } from "@/hooks/usePrompts";
import { useAddPromptDeepLink } from "@/hooks/useAddPromptDeepLink";
import { CreatePromptDialog } from "@/components/CreatePromptDialog";
import { LibraryCard } from "@/components/LibraryCard";

export default function LibraryPage() {
  const { prompts, isLoading, createPrompt, updatePrompt, deletePrompt } =
    usePrompts();
  const { prefillData, dialogOpen, handleDialogClose } = useAddPromptDeepLink();

  return (
    <div className="w-full px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-bold sm:text-3xl page-title">Library: Prompts</h1>
          <div className="shrink-0">
            <CreatePromptDialog
              onCreatePrompt={createPrompt}
              prefillData={prefillData}
              isOpen={dialogOpen}
              onOpenChange={handleDialogClose}
            />
          </div>
        </div>

        {isLoading ? (
          <div className="rounded-xl border border-border/60 bg-card p-8 text-center text-muted-foreground">
            Loading...
          </div>
        ) : prompts.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card p-10 text-center">
            <h3 className="text-lg font-semibold text-foreground mb-1">
              No prompts yet
            </h3>
            <p className="text-sm text-muted-foreground">
              Create one to get started.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
      </div>
    </div>
  );
}
