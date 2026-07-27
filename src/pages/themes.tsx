import { useState } from "react";
import { Palette, Plus } from "lucide-react";
import { useCustomThemes } from "@/hooks/useCustomThemes";
import { CustomThemeDialog } from "@/components/CustomThemeDialog";
import { LibraryCard } from "@/components/LibraryCard";
import { SpaceHeader } from "@/shell/SpaceHeader";
import {
  EmptyState,
  LBadge,
  LButton,
  LoadingState,
  PageShell,
} from "@/components/liquid";

/** Visual presets applied to generated apps. */
export default function ThemesPage() {
  const { customThemes, isLoading } = useCustomThemes();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const newThemeButton = (
    <LButton
      tone="primary"
      size="compact"
      icon={<Plus />}
      onClick={() => setCreateDialogOpen(true)}
    >
      New theme
    </LButton>
  );

  return (
    <PageShell
      width="wide"
      header={
        <SpaceHeader
          meta={
            customThemes.length > 0 ? (
              <LBadge tone="neutral">{customThemes.length} custom</LBadge>
            ) : undefined
          }
          actions={newThemeButton}
        />
      }
    >
      {isLoading ? (
        <LoadingState label="themes" />
      ) : customThemes.length === 0 ? (
        <EmptyState
          icon={<Palette />}
          title="No custom themes yet"
          description="A theme fixes the palette, type and spacing Orion uses when it generates an interface, so every project you ship looks like yours."
          action={newThemeButton}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {customThemes.map((theme) => (
            <LibraryCard key={theme.id} item={{ type: "theme", data: theme }} />
          ))}
        </div>
      )}

      <CustomThemeDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </PageShell>
  );
}
