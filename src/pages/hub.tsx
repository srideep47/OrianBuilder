import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useSettings } from "@/hooks/useSettings";
import { useTemplates } from "@/hooks/useTemplates";
import { TemplateCard } from "@/components/TemplateCard";
import { CreateAppDialog } from "@/components/CreateAppDialog";

const HubPage: React.FC = () => {
  const router = useRouter();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const { templates, isLoading } = useTemplates();
  const { settings, updateSettings } = useSettings();
  const selectedTemplateId = settings?.selectedTemplateId;

  const handleTemplateSelect = (templateId: string) => {
    updateSettings({ selectedTemplateId: templateId });
  };

  const handleCreateApp = () => {
    setIsCreateDialogOpen(true);
  };
  // Separate templates into official and community
  const officialTemplates =
    templates?.filter((template) => template.isOfficial) || [];
  const communityTemplates =
    templates?.filter((template) => !template.isOfficial) || [];

  return (
    <div className="hub-page"  style={{ color: '#fff' }}>
      <div className="max-w-5xl mx-auto pb-12">
        <Button
          onClick={() => router.history.back()}
          variant="ghost"
          size="sm"
          className="galaxy-sidebar-btn flex items-center gap-2 mb-6 py-5"
        >
          <ArrowLeft className="h-4 w-4" />
          Go Back
        </Button>

        <div className="galaxy-page-header">
          <h1 className="galaxy-page-title">Template Hub</h1>
          <p className="galaxy-page-subtitle">
            Choose a launchpad for your next project
            {isLoading && " — loading templates…"}
          </p>
        </div>

        {/* Official Templates */}
        {officialTemplates.length > 0 && (
          <section className="mb-10">
            <h2 className="galaxy-section-label">Official templates</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {officialTemplates.map((template, i) => (
                <div
                  key={template.id}
                  className="galaxy-card overflow-hidden"
                  style={{ animationDelay: `${i * 0.06}s` }}
                >
                  <TemplateCard
                    template={template}
                    isSelected={template.id === selectedTemplateId}
                    onSelect={handleTemplateSelect}
                    onCreateApp={handleCreateApp}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Community Templates */}
        {communityTemplates.length > 0 && (
          <section className="mb-10">
            <h2 className="galaxy-section-label">Community templates</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {communityTemplates.map((template, i) => (
                <div
                  key={template.id}
                  className="galaxy-card overflow-hidden"
                  style={{ animationDelay: `${(officialTemplates.length + i) * 0.06}s` }}
                >
                  <TemplateCard
                    template={template}
                    isSelected={template.id === selectedTemplateId}
                    onSelect={handleTemplateSelect}
                    onCreateApp={handleCreateApp}
                  />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <CreateAppDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        template={templates?.find((t) => t.id === settings?.selectedTemplateId)}
      />
    </div>
  );
};

export default HubPage;
