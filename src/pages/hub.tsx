import React, { useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useTemplates } from "@/hooks/useTemplates";
import { TemplateCard } from "@/components/TemplateCard";
import { CreateAppDialog } from "@/components/CreateAppDialog";
import { SpaceHeader } from "@/shell/SpaceHeader";
import {
  EmptyState,
  LBadge,
  LoadingState,
  PageShell,
  Section,
  Stack,
} from "@/components/liquid";

/**
 * Project starting points, split into what we ship and what the community
 * contributed.
 *
 * Reached at `/templates`; it used to live at `/hub`, which meant something
 * completely different in the rest of the product. The selected template is
 * marked with a badge in the header so the page states its own effect — before,
 * the only signal was a highlight on one card somewhere down the grid.
 */
const TemplatesPage: React.FC = () => {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const { templates, isLoading } = useTemplates();
  const { settings, updateSettings } = useSettings();
  const selectedTemplateId = settings?.selectedTemplateId;

  const handleTemplateSelect = (templateId: string) => {
    updateSettings({ selectedTemplateId: templateId });
  };

  const handleCreateApp = () => setIsCreateDialogOpen(true);

  const officialTemplates = templates?.filter((t) => t.isOfficial) ?? [];
  const communityTemplates = templates?.filter((t) => !t.isOfficial) ?? [];
  const selected = templates?.find((t) => t.id === selectedTemplateId);
  const hasAny = officialTemplates.length + communityTemplates.length > 0;

  return (
    <PageShell
      width="wide"
      header={
        <SpaceHeader
          title="Templates"
          description="Pick the default starting point for new projects. Orion still overrides it when your prompt clearly implies a different stack."
          meta={
            selected ? (
              <LBadge tone="accent" dot>
                Default: {selected.title}
              </LBadge>
            ) : undefined
          }
        />
      }
    >
      {isLoading && !hasAny ? (
        <LoadingState label="templates" />
      ) : !hasAny ? (
        <EmptyState
          icon={<LayoutTemplate />}
          title="No templates available"
          description="The bundled templates failed to load. Check your connection and reopen this view."
        />
      ) : (
        <Stack gap="major">
          {officialTemplates.length > 0 && (
            <Section
              title="Official"
              description="Maintained by Orion and kept current with each release."
            >
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {officialTemplates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    isSelected={template.id === selectedTemplateId}
                    onSelect={handleTemplateSelect}
                    onCreateApp={handleCreateApp}
                  />
                ))}
              </div>
            </Section>
          )}

          {communityTemplates.length > 0 && (
            <Section
              title="Community"
              description="Contributed templates. Review the source before shipping anything built on one."
            >
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {communityTemplates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    isSelected={template.id === selectedTemplateId}
                    onSelect={handleTemplateSelect}
                    onCreateApp={handleCreateApp}
                  />
                ))}
              </div>
            </Section>
          )}

          {isLoading && (
            <LoadingState compact label="more community templates" />
          )}
        </Stack>
      )}

      <CreateAppDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        template={selected}
      />
    </PageShell>
  );
};

export default TemplatesPage;
