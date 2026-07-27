import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import {
  Panel as SplitPanel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import {
  Boxes,
  Blocks,
  CircleStop,
  Cpu,
  Download,
  ExternalLink,
  FolderPlus,
  Gamepad2,
  Hammer,
  Monitor,
  Package,
  Play,
  RefreshCw,
  ScanEye,
  SquareTerminal,
} from "lucide-react";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { ipc } from "@/ipc/types";
import type {
  BlenderInstallInfo,
  GodotAssetKind,
  GodotExportTarget,
  GodotProject,
} from "@/ipc/types";
import { showError, showSuccess } from "@/lib/toast";
import { SpaceHeader } from "@/shell/SpaceHeader";
import {
  Card,
  EmptyState,
  Group,
  LBadge,
  LButton,
  LoadingState,
  PageShell,
  Panel,
  Row,
  Section,
  Segmented,
  Stack,
  StatTile,
} from "@/components/liquid";
import { GodotViewport } from "@/components/game/GodotViewport";
import { GodotSceneTree } from "@/components/game/GodotSceneTree";
import { GodotInspector } from "@/components/game/GodotInspector";
import { useGodotStatus, useSceneTree } from "@/components/game/useGodot";

type View = "engine" | "assets" | "build" | "setup";

const VIEWS = [
  { value: "engine" as const, label: "Engine", icon: <Gamepad2 /> },
  { value: "assets" as const, label: "Assets", icon: <Boxes /> },
  { value: "build" as const, label: "Build", icon: <Package /> },
  { value: "setup" as const, label: "Setup", icon: <Cpu /> },
];

/**
 * The Game space.
 *
 * Both halves of the ask live here: full manual control of a real Godot engine —
 * launch, viewport, scene tree, live property editing, pause and single-frame
 * step, export — and the setup surface for the automation that drives the same
 * engine through the `godot_*` and `blender_*` agent tools.
 *
 * It's a space rather than a dock panel because game development isn't one panel's
 * worth of work: a scene tree, an inspector and a viewport all need to be visible
 * at once, which is a whole window, not a sidebar.
 */
export default function GamePage() {
  const [view, setView] = useState<View>("engine");
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { apps } = useLoadApps();
  const app = apps.find((a) => a.id === selectedAppId) ?? null;

  const { status, refresh } = useGodotStatus();
  const [project, setProject] = useState<GodotProject | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const running = status?.state === "running" && status.mode !== "editor";
  const bridgeReady = Boolean(status?.bridgeReady);
  const tree = useSceneTree(running && bridgeReady);

  const loadProject = useCallback(async () => {
    if (selectedAppId == null) {
      setProject(null);
      return;
    }
    setProjectLoading(true);
    try {
      setProject(await ipc.godot.findProject({ appId: selectedAppId }));
    } catch {
      setProject(null);
    } finally {
      setProjectLoading(false);
    }
  }, [selectedAppId]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  const createProject = async (template: "3d" | "2d" | "ui") => {
    if (selectedAppId == null) return;
    setBusy(true);
    try {
      const created = await ipc.godot.createProject({
        appId: selectedAppId,
        template,
      });
      setProject(created);
      showSuccess(`Created Godot project “${created.name}”`);
    } catch (err) {
      showError(`Could not create the project: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const launch = async (mode: "windowed" | "headless" | "editor") => {
    if (selectedAppId == null) return;
    setBusy(true);
    try {
      await ipc.godot.start({ appId: selectedAppId, mode });
      setPaused(false);
      await refresh();
    } catch (err) {
      showError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await ipc.godot.stop(undefined);
      setSelectedNode(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <SpaceHeader
      title="Game"
      description="Drive a real Godot engine by hand or let Orion build the game for you — scenes, assets, animation, audio and builds."
      meta={
        <>
          {status?.install ? (
            <LBadge tone={status.install.supported ? "success" : "warning"} dot>
              Godot {status.install.version.replace(/^Godot Engine v?/i, "")}
            </LBadge>
          ) : (
            <LBadge tone="warning">Godot not found</LBadge>
          )}
          {running && (
            <LBadge tone={bridgeReady ? "accent" : "warning"} dot>
              {bridgeReady
                ? `running · ${status?.mode}`
                : "bridge not answering"}
            </LBadge>
          )}
        </>
      }
      actions={
        <>
          <Segmented
            aria-label="Game view"
            size="compact"
            options={VIEWS}
            value={view}
            onChange={setView}
          />
          {running ? (
            <LButton
              size="compact"
              tone="destructive"
              icon={<CircleStop />}
              disabled={busy}
              onClick={() => void stop()}
            >
              Stop
            </LButton>
          ) : (
            <LButton
              size="compact"
              tone="primary"
              icon={<Play />}
              disabled={busy || !project || selectedAppId == null}
              onClick={() => void launch("windowed")}
            >
              Run
            </LButton>
          )}
        </>
      }
    />
  );

  if (selectedAppId == null) {
    return (
      <PageShell width="content" header={header}>
        <EmptyState
          icon={<Gamepad2 />}
          title="No project selected"
          description="Open or create a project in Build, then come back here to give it a game."
        />
      </PageShell>
    );
  }

  if (projectLoading) {
    return (
      <PageShell width="content" header={header}>
        <LoadingState label="the Godot project" />
      </PageShell>
    );
  }

  if (!project) {
    return (
      <PageShell width="content" header={header}>
        <NoProject
          appName={app?.name ?? "this project"}
          busy={busy}
          onCreate={createProject}
        />
      </PageShell>
    );
  }

  if (view === "engine") {
    return (
      <PageShell
        width="full"
        fill
        header={<div className="px-6">{header}</div>}
      >
        <EngineWorkbench
          running={running}
          bridgeReady={bridgeReady}
          paused={paused}
          onPausedChange={setPaused}
          project={project}
          output={status?.output ?? []}
          error={status?.error ?? null}
          selectedNode={selectedNode}
          onSelectNode={setSelectedNode}
          tree={tree}
          busy={busy}
          onLaunch={launch}
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="content" header={header}>
      {view === "assets" ? (
        <AssetsView project={project} />
      ) : view === "build" ? (
        <BuildView project={project} />
      ) : (
        <SetupView onGodotChanged={refresh} />
      )}
    </PageShell>
  );
}

/* ────────────────────────── No project yet ────────────────────────── */

function NoProject({
  appName,
  busy,
  onCreate,
}: {
  appName: string;
  busy: boolean;
  onCreate: (template: "3d" | "2d" | "ui") => void;
}) {
  const templates = [
    {
      id: "3d" as const,
      title: "3D",
      detail:
        "Lit scene with a camera, ground plane, World and UI layers. Forward+ renderer.",
      icon: Boxes,
    },
    {
      id: "2d" as const,
      title: "2D",
      detail: "Node2D world with a camera and a UI layer. Mobile renderer.",
      icon: Blocks,
    },
    {
      id: "ui" as const,
      title: "Interface",
      detail:
        "Full-rect Control with a vertical container. For menus and HUDs.",
      icon: Monitor,
    },
  ];

  return (
    <Stack gap="section">
      <Section
        title={`Give ${appName} a game`}
        description="Creates project.godot with a sane renderer and input map, a starter scene with stable node paths, asset folders, and the Orion control bridge already installed."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {templates.map(({ id, title, detail, icon: Icon }) => (
            <Card
              key={id}
              corner="md"
              disabled={busy}
              onSelect={() => onCreate(id)}
              className="flex flex-col gap-2 p-4"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-primary/12 text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-[13px] font-semibold text-foreground">
                {title}
              </span>
              <span className="text-[12px] leading-[1.45] text-muted-foreground">
                {detail}
              </span>
            </Card>
          ))}
        </div>
      </Section>

      <Group
        title="What Orion can do once it exists"
        description="Everything below is available to the agent in chat as well as by hand here."
      >
        <Row
          leading={<Boxes />}
          title="Build scenes live"
          subtitle="Create and delete nodes, set any property, call any method — against the running engine, then save."
        />
        <Row
          leading={<Hammer />}
          title="Generate and clean up assets"
          subtitle="Meshes, textures, sprites, UI, music, sound effects, voice and video — decimated, unwrapped, scaled and imported automatically."
        />
        <Row
          leading={<ScanEye />}
          title="Verify by looking"
          subtitle="Screenshot the viewport, simulate input, step frame by frame, and read real FPS and draw-call counts."
        />
        <Row
          leading={<Package />}
          title="Export a real build"
          subtitle="Windows, Linux, macOS, Web or Android through the engine's own headless exporter."
        />
      </Group>
    </Stack>
  );
}

/* ────────────────────────── Engine workbench ────────────────────────── */

function EngineWorkbench({
  running,
  bridgeReady,
  paused,
  onPausedChange,
  project,
  output,
  error,
  selectedNode,
  onSelectNode,
  tree,
  busy,
  onLaunch,
}: {
  running: boolean;
  bridgeReady: boolean;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  project: GodotProject;
  output: string[];
  error: string | null;
  selectedNode: string | null;
  onSelectNode: (path: string | null) => void;
  tree: ReturnType<typeof useSceneTree>;
  busy: boolean;
  onLaunch: (mode: "windowed" | "headless" | "editor") => void;
}) {
  const saveScene = async () => {
    const res = await ipc.godot.call({ action: "save_scene" });
    if (res.ok === true) showSuccess(`Saved ${res.path}`);
    else showError(`Save failed: ${res.error}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-6 pb-4">
      {/* Launch strip — the modes are a real choice, so they're all visible
          rather than hidden behind a dropdown. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <LButton
          size="compact"
          tone={running ? "glass" : "primary"}
          icon={<Monitor />}
          disabled={busy || running}
          onClick={() => onLaunch("windowed")}
        >
          Windowed
        </LButton>
        <LButton
          size="compact"
          icon={<SquareTerminal />}
          disabled={busy || running}
          onClick={() => onLaunch("headless")}
        >
          Headless
        </LButton>
        <LButton
          size="compact"
          icon={<ExternalLink />}
          disabled={busy || running}
          onClick={() => onLaunch("editor")}
        >
          Godot editor
        </LButton>
        <span className="mx-1 h-4 w-px bg-white/[0.12]" />
        <LButton
          size="compact"
          disabled={!running || !bridgeReady}
          onClick={() => void saveScene()}
        >
          Save scene
        </LButton>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {project.name} · {project.mainScene ?? "no main scene"} ·{" "}
          {project.renderer ?? "default renderer"}
        </span>
      </div>

      {error && (
        <div className="shrink-0">
          <LBadge tone="warning">{error}</LBadge>
        </div>
      )}

      {/* Three panes: tree, viewport, inspector. All resizable and persisted —
          how much room each deserves depends entirely on what you're doing. */}
      <div className="min-h-0 flex-1">
        <PanelGroup autoSaveId="orion.game.engine" direction="horizontal">
          <SplitPanel id="tree" defaultSize={22} minSize={14}>
            <GodotSceneTree
              root={tree.root}
              error={tree.error}
              loading={tree.loading}
              selected={selectedNode}
              onSelect={onSelectNode}
              onRefresh={() => void tree.refresh()}
              className="h-full"
            />
          </SplitPanel>
          <PanelResizeHandle className="w-2 shrink-0" />
          <SplitPanel id="viewport" defaultSize={52} minSize={28}>
            <div className="flex h-full min-h-0 flex-col gap-3">
              <GodotViewport
                running={running && bridgeReady}
                paused={paused}
                onPausedChange={onPausedChange}
                className="min-h-0 flex-1"
              />
              <EngineOutput output={output} />
            </div>
          </SplitPanel>
          <PanelResizeHandle className="w-2 shrink-0" />
          <SplitPanel id="inspector" defaultSize={26} minSize={16}>
            <GodotInspector nodePath={selectedNode} className="h-full" />
          </SplitPanel>
        </PanelGroup>
      </div>
    </div>
  );
}

/** Engine stdout. The only place a GDScript error actually appears. */
function EngineOutput({ output }: { output: string[] }) {
  const [open, setOpen] = useState(false);
  const errors = useMemo(
    () => output.filter((l) => /error|failed|cannot/i.test(l)).length,
    [output],
  );

  return (
    <Panel
      title="Engine output"
      subtitle={
        output.length === 0
          ? "nothing yet"
          : `${output.length} lines${errors ? ` · ${errors} look like errors` : ""}`
      }
      icon={<SquareTerminal />}
      flush
      className={open ? "h-[220px] shrink-0" : "shrink-0"}
      actions={
        <LButton size="compact" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </LButton>
      }
      bodyClassName={open ? "min-h-0 overflow-y-auto p-2" : "hidden"}
    >
      {open &&
        (output.length === 0 ? (
          <p className="p-2 text-[12px] text-muted-foreground">
            The engine has not printed anything yet.
          </p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.5] text-foreground/80">
            {output.join("\n")}
          </pre>
        ))}
    </Panel>
  );
}

/* ────────────────────────── Assets ────────────────────────── */

const ASSET_LABELS: Record<GodotAssetKind, string> = {
  models: "Models",
  textures: "Textures",
  materials: "Materials",
  animations: "Animations",
  audio: "Sound effects",
  music: "Music",
  voice: "Voice",
  video: "Video",
  ui: "Interface",
};

function AssetsView({ project }: { project: GodotProject }) {
  const [assets, setAssets] = useState<Partial<
    Record<GodotAssetKind, string[]>
  > | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAssets(await ipc.godot.listAssets({ projectDir: project.dir }));
    } catch {
      setAssets(null);
    } finally {
      setLoading(false);
    }
  }, [project.dir]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = useMemo(
    () =>
      Object.values(assets ?? {}).reduce(
        (sum, list) => sum + (list?.length ?? 0),
        0,
      ),
    [assets],
  );

  if (loading) return <LoadingState label="assets" />;

  return (
    <Stack gap="section">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Assets imported" value={total} />
        <StatTile
          label="Project"
          value={<span className="text-[13px]">{project.name}</span>}
          hint={project.dir}
        />
        <StatTile
          label="Control bridge"
          value={
            <span className="text-[13px]">
              {project.bridgeInstalled ? "installed" : "missing"}
            </span>
          }
          hint={
            project.bridgeVersion != null
              ? `version ${project.bridgeVersion}`
              : "installs on next launch"
          }
        />
      </div>

      {total === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No assets yet"
          description="Ask Orion in chat: “generate a weathered wooden crate, about 1 metre, and put it in the scene”. It generates the mesh, decimates it, unwraps UVs, normalises the scale, fixes the origin, imports it and places it."
        />
      ) : (
        (Object.keys(ASSET_LABELS) as GodotAssetKind[])
          .filter((kind) => (assets?.[kind]?.length ?? 0) > 0)
          .map((kind) => (
            <Section
              key={kind}
              title={ASSET_LABELS[kind]}
              description={`${assets?.[kind]?.length ?? 0} files`}
            >
              <Group>
                {(assets?.[kind] ?? []).map((resPath) => (
                  <Row
                    key={resPath}
                    dense
                    leading={<Boxes />}
                    title={
                      <span className="font-mono text-[12px]">
                        {resPath.split("/").pop()}
                      </span>
                    }
                    subtitle={resPath}
                  />
                ))}
              </Group>
            </Section>
          ))
      )}

      <div>
        <LButton
          size="compact"
          icon={<RefreshCw />}
          onClick={() => void load()}
        >
          Rescan
        </LButton>
      </div>
    </Stack>
  );
}

/* ────────────────────────── Build ────────────────────────── */

const TARGETS: Array<{ id: GodotExportTarget; label: string; detail: string }> =
  [
    { id: "windows", label: "Windows", detail: "Standalone .exe" },
    { id: "linux", label: "Linux", detail: "x86_64 binary" },
    { id: "macos", label: "macOS", detail: "Signed-less .zip bundle" },
    { id: "web", label: "Web", detail: "WASM + HTML, needs a server" },
    { id: "android", label: "Android", detail: "APK, needs the Android SDK" },
  ];

function BuildView({ project }: { project: GodotProject }) {
  const [running, setRunning] = useState<GodotExportTarget | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      const res = await ipc.godot.checkProject({ projectDir: project.dir });
      setLog(res.output);
      if (res.ok) showSuccess("Scripts parsed clean");
      else showError("The engine reported script errors — see the log below");
    } finally {
      setChecking(false);
    }
  };

  const exportTo = async (target: GodotExportTarget) => {
    setRunning(target);
    setLog(null);
    try {
      const res = await ipc.godot.exportProject({
        projectDir: project.dir,
        target,
      });
      setLog(res.log);
      if (res.ok) showSuccess(`Exported to ${res.outputPath}`);
      else showError(res.error ?? "Export failed");
    } finally {
      setRunning(null);
    }
  };

  return (
    <Stack gap="section">
      <Section
        title="Verify"
        description="Parses every script with the engine's own parser, headless. Seconds, versus a 30-second engine start to find the same error."
      >
        <LButton
          size="compact"
          icon={<ScanEye />}
          disabled={checking}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check scripts"}
        </LButton>
      </Section>

      <Section
        title="Export"
        description="Uses Godot's own headless exporter, so the artifact is identical to one produced from the editor. Requires the matching export templates for your engine version."
      >
        <Group>
          {TARGETS.map((target) => (
            <Row
              key={target.id}
              leading={<Package />}
              title={target.label}
              subtitle={target.detail}
              trailing={
                <LButton
                  size="compact"
                  tone={running === target.id ? "glass" : "primary"}
                  icon={<Download />}
                  disabled={running !== null}
                  onClick={() => void exportTo(target.id)}
                >
                  {running === target.id ? "Exporting…" : "Export"}
                </LButton>
              }
            />
          ))}
        </Group>
      </Section>

      {log && (
        <Panel
          title="Engine log"
          icon={<SquareTerminal />}
          scrollBody
          className="max-h-[420px]"
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.5] text-foreground/80">
            {log}
          </pre>
        </Panel>
      )}
    </Stack>
  );
}

/* ────────────────────────── Setup ────────────────────────── */

function SetupView({ onGodotChanged }: { onGodotChanged: () => void }) {
  // Re-scanning changes which engine the rest of the app will launch, so the
  // header's status badge has to be refreshed too.
  const [godot, setGodot] =
    useState<Awaited<ReturnType<typeof ipc.godot.locate>>>(null);
  const [blender, setBlender] = useState<BlenderInstallInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const [g, b] = await Promise.all([
          ipc.godot.locate({ force }),
          ipc.blender.locate({ force }),
        ]);
        setGodot(g);
        setBlender(b);
        if (force) onGodotChanged();
      } finally {
        setLoading(false);
      }
    },
    [onGodotChanged],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="engine and tool discovery" />;

  return (
    <Stack gap="section">
      <Section
        title="Godot"
        description="The engine Orion drives. Any official Godot 4.2+ build works — Orion installs its control bridge into each project rather than needing a patched engine."
        action={
          <LButton
            size="compact"
            icon={<RefreshCw />}
            onClick={() => void load(true)}
          >
            Re-scan
          </LButton>
        }
      >
        <Group>
          <Row
            leading={<Gamepad2 />}
            title={godot ? godot.version : "Not found"}
            subtitle={
              godot
                ? `${godot.executable} · discovered via ${godot.source}`
                : "Install Godot 4 and it will be picked up automatically from PATH or the usual install locations."
            }
            trailing={
              godot ? (
                <LBadge tone={godot.supported ? "success" : "warning"}>
                  {godot.supported ? "supported" : "too old"}
                </LBadge>
              ) : (
                <LButton
                  size="compact"
                  tone="primary"
                  icon={<ExternalLink />}
                  onClick={() =>
                    void ipc.system.openExternalUrl(
                      "https://godotengine.org/download",
                    )
                  }
                >
                  Download
                </LButton>
              )
            }
          />
        </Group>
      </Section>

      <Section
        title="Blender"
        description="Optional but strongly recommended. Generated meshes arrive at arbitrary scale with no UVs and hundreds of thousands of triangles; Blender is what makes them usable, and it also does the rigging and animation."
      >
        <Group>
          <Row
            leading={<Blocks />}
            title={blender ? blender.version : "Not found"}
            subtitle={
              blender
                ? `${blender.executable} · discovered via ${blender.source}`
                : "Without Blender, generated meshes are imported raw — untextur­able, wrongly scaled, and heavy."
            }
            trailing={
              blender ? (
                <LBadge tone={blender.supported ? "success" : "warning"}>
                  {blender.supported ? "supported" : "too old"}
                </LBadge>
              ) : (
                <LButton
                  size="compact"
                  icon={<ExternalLink />}
                  onClick={() =>
                    void ipc.system.openExternalUrl(
                      "https://www.blender.org/download/",
                    )
                  }
                >
                  Download
                </LButton>
              )
            }
          />
        </Group>
      </Section>

      <Section
        title="Generation models"
        description="Meshes, textures, music, voice and video all come from the local media runtime. Install and pick tiers on the Engine and Create pages."
      >
        <Group>
          <Row
            leading={<Cpu />}
            title="Media runtime"
            subtitle="Image, video, audio, music and 3D reconstruction models."
            trailing={
              <LButton
                size="compact"
                onClick={() => {
                  window.location.hash = "";
                  void ipc.system.openExternalUrl;
                }}
              >
                Create → Studio
              </LButton>
            }
          />
        </Group>
      </Section>

      <Section title="How automation reaches the engine">
        <Group>
          <Row
            leading={<FolderPlus />}
            title="Control bridge"
            subtitle="A GDScript autoload Orion writes into each project. It listens on 127.0.0.1:8139 and speaks newline-delimited JSON, authenticated by a token the engine regenerates on every start. Identical protocol to Orion on Android."
          />
        </Group>
      </Section>
    </Stack>
  );
}
