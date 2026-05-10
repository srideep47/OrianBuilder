import { usePrompts } from "@/hooks/usePrompts";
import { useAddPromptDeepLink } from "@/hooks/useAddPromptDeepLink";
import { CreatePromptDialog } from "@/components/CreatePromptDialog";
import { LibraryCard } from "@/components/LibraryCard";

export default function LibraryPage() {
  const { prompts, isLoading, createPrompt, updatePrompt, deletePrompt } =
    usePrompts();
  const { prefillData, dialogOpen, handleDialogClose } = useAddPromptDeepLink();

  return (
    <div className="lib-content"  style={{ color: '#fff' }}>
      <div className="mx-auto max-w-6xl">
        <div className="galaxy-page-header">
          <h1 className="galaxy-page-title">Prompt Library</h1>
          <p className="galaxy-page-subtitle">
            Your reusable prompt collection — craft once, deploy anywhere
          </p>
        </div>

        <div className="mb-6 flex justify-end">
          <CreatePromptDialog
            onCreatePrompt={createPrompt}
            prefillData={prefillData}
            isOpen={dialogOpen}
            onOpenChange={handleDialogClose}
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="galaxy-card px-8 py-6 flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-purple-400/60 border-t-purple-300 rounded-full animate-spin" />
              <span className="text-sm text-purple-200/70">Loading prompts...</span>
            </div>
          </div>
        ) : prompts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="galaxy-card px-10 py-10 text-center max-w-sm">
              <div className="text-4xl mb-4 opacity-60">📝</div>
              <p className="text-purple-100/80 font-medium mb-1">No prompts yet</p>
              <p className="text-sm text-purple-200/50">Create your first reusable prompt to get started</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {prompts.map((p, i) => (
              <div
                key={p.id}
                className="galaxy-card"
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <LibraryCard
                  item={{ type: "prompt", data: p }}
                  onUpdatePrompt={updatePrompt}
                  onDeletePrompt={deletePrompt}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
