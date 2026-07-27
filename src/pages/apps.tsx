import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FolderKanban, Search, X } from "lucide-react";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useOpenApp } from "@/hooks/useOpenApp";
import { AppShowcaseCard } from "@/components/AppShowcaseCard";
import { useAppThumbnails } from "@/hooks/useAppThumbnails";
import { sortAppsForShowcase } from "@/lib/sortApps";
import { ImportAppButton } from "@/components/ImportAppButton";
import { SpaceHeader } from "@/shell/SpaceHeader";
import {
  EmptyState,
  LBadge,
  LButton,
  LIconButton,
  LInput,
  LoadingState,
  PageShell,
} from "@/components/liquid";

/**
 * Every project you've built.
 *
 * The page used to open with a "Go Back" button — a mobile pattern in a shell
 * with a permanent nav rail, where there is no "back" to go to. Navigation is
 * the rail and the space switcher; the header carries the project count and the
 * one action that genuinely belongs to this view.
 */
export default function AppsPage() {
  const navigate = useNavigate();
  const { apps, loading } = useLoadApps();
  const openApp = useOpenApp();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredApps = useMemo(() => {
    const sorted = sortAppsForShowcase(apps);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((app) => app.name.toLowerCase().includes(q));
  }, [apps, searchQuery]);

  // Fetch thumbnails for ALL apps once and filter client-side so typing in
  // the search box doesn't trigger a burst of IPC + filesystem reads. This
  // also lets the underlying query cache be shared with the featured
  // showcase on the home page.
  const allAppIds = useMemo(() => apps.map((a) => a.id), [apps]);
  const thumbnailByAppId = useAppThumbnails(allAppIds);

  return (
    <PageShell
      width="wide"
      header={
        <SpaceHeader
          meta={
            !loading && apps.length > 0 ? (
              <LBadge tone="neutral">
                {apps.length} {apps.length === 1 ? "project" : "projects"}
              </LBadge>
            ) : undefined
          }
          actions={<ImportAppButton className="px-0 pb-0" />}
          toolbar={
            apps.length > 0 ? (
              <LInput
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search projects by name…"
                aria-label="Search projects"
                icon={<Search />}
                wrapperClassName="max-w-[380px]"
                trailing={
                  searchQuery ? (
                    <LIconButton
                      label="Clear search"
                      size="compact"
                      onClick={() => setSearchQuery("")}
                    >
                      <X />
                    </LIconButton>
                  ) : undefined
                }
              />
            ) : undefined
          }
        />
      }
    >
      {loading ? (
        <LoadingState label="projects" />
      ) : filteredApps.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title={
            searchQuery ? `Nothing matches “${searchQuery}”` : "No projects yet"
          }
          description={
            searchQuery
              ? "Try a shorter query, or clear the search to see everything."
              : "Describe what you want in the Orion command box and the first one gets created for you."
          }
          action={
            searchQuery ? (
              <LButton size="compact" onClick={() => setSearchQuery("")}>
                Clear search
              </LButton>
            ) : (
              <LButton
                size="compact"
                tone="primary"
                onClick={() => navigate({ to: "/" })}
              >
                Start a project
              </LButton>
            )
          }
        />
      ) : (
        <div
          data-testid="apps-grid"
          className="grid grid-cols-[repeat(auto-fill,minmax(228px,1fr))] gap-4"
        >
          {filteredApps.map((app) => (
            <AppShowcaseCard
              key={app.id}
              app={app}
              thumbnailUrl={thumbnailByAppId.get(app.id) ?? null}
              onClick={openApp}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
