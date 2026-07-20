import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Box,
  BookMarked,
  CheckCircle2,
  ChevronDown,
  Download,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Server,
  ServerOff,
  Sparkles,
  Square,
  Type as TypeIcon,
  Upload,
  Wrench,
} from "lucide-react";
import { ipc, type MediaAiStatus } from "@/ipc/types";
import { useExclusiveMediaSession } from "@/hooks/useExclusiveMediaSession";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ThreeDTierInfo {
  id: string;
  label: string;
  description: string;
  vram_mb: number;
  download_size_mb: number;
  backends: string[];
  hf_repo: string;
  repo_url: string;
  available_for_backend: boolean;
  status: "downloaded" | "downloading" | "not_downloaded";
  download_progress?: number | null;
  selected: boolean;
}

interface ImageTierInfo {
  id: string;
  label: string;
  description?: string;
  vram_mb: number;
  download_size_mb: number;
  backends?: string[];
  available_for_backend: boolean;
  status: "downloaded" | "downloading" | "not_downloaded";
  download_progress?: number | null;
  selected: boolean;
}

const THREED_TIER_CATALOG: ThreeDTierInfo[] = [
  {
    id: "triposr-6gb",
    label: "TripoSR (6 GB)",
    description:
      "Stability AI's TripoSR — image-to-3D reconstruction in roughly 1 second on a 6 GB GPU. Text prompts are first turned into a reference image, then reconstructed in 3D.",
    vram_mb: 4000,
    download_size_mb: 1700,
    backends: ["cuda", "rocm", "mps", "metal", "cpu"],
    hf_repo: "stabilityai/TripoSR",
    repo_url: "https://github.com/VAST-AI-Research/TripoSR",
    available_for_backend: true,
    status: "not_downloaded",
    download_progress: null,
    selected: true,
  },
];

type InputMode = "text" | "image";
type GenStatus = "idle" | "image-gen" | "mesh-gen" | "done" | "error";

const TIER_DOWNLOAD_CACHE_KEY = "orianbuilder.threed.downloadedTiers";

function loadCachedDownloadedTiers(): Set<string> {
  try {
    const raw = window.localStorage.getItem(TIER_DOWNLOAD_CACHE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed))
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    // non-fatal
  }
  return new Set();
}

function saveCachedDownloadedTiers(tiers: Set<string>): void {
  try {
    window.localStorage.setItem(
      TIER_DOWNLOAD_CACHE_KEY,
      JSON.stringify([...tiers]),
    );
  } catch {
    // non-fatal
  }
}

const ModelViewer = lazy(() => import("@/components/threed/ModelViewer"));

export default function ThreeDAssetsPage() {
  const mediaSession = useExclusiveMediaSession();
  const [status, setStatus] = useState<MediaAiStatus | null>(null);
  const [tiers, setTiers] = useState<ThreeDTierInfo[]>([]);
  const [tiersLoading, setTiersLoading] = useState(false);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(
    THREED_TIER_CATALOG[0]?.id ?? null,
  );
  const [downloadTierId, setDownloadTierId] = useState<string | null>(null);
  const downloadPollRef = useRef<number | null>(null);

  const [setupRunning, setSetupRunning] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [runtimeMissing, setRuntimeMissing] = useState(false);
  const [startingBackend, setStartingBackend] = useState(false);
  const [cachedDownloaded, setCachedDownloaded] = useState<Set<string>>(() =>
    loadCachedDownloadedTiers(),
  );

  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [prompt, setPrompt] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [genStatus, setGenStatus] = useState<GenStatus>("idle");
  const [genError, setGenError] = useState("");
  const [genStage, setGenStage] = useState<string>("");
  const [glbUrl, setGlbUrl] = useState<string | null>(null);
  const [genImageFullUrl, setGenImageFullUrl] = useState<string | null>(null);
  const [meshResolution, setMeshResolution] = useState<256 | 320 | 384 | 512>(
    320,
  );
  const genAbortRef = useRef<AbortController | null>(null);

  const [imageTiers, setImageTiers] = useState<ImageTierInfo[]>([]);
  const [imageTiersLoading, setImageTiersLoading] = useState(false);
  const [imageTiersExpanded, setImageTiersExpanded] = useState(true);
  const [imageDownloadTierId, setImageDownloadTierId] = useState<string | null>(
    null,
  );
  const imageDownloadPollRef = useRef<number | null>(null);

  const serverUrl = status?.serverUrl ?? "http://127.0.0.1:8000";
  const isBackendOnline = status?.healthy === true;

  const tierList = (
    tiers.length > 0
      ? THREED_TIER_CATALOG.map((c) => tiers.find((t) => t.id === c.id) ?? c)
      : THREED_TIER_CATALOG
  ).map((t) =>
    // When the backend is offline we cannot ask it whether the model is
    // downloaded — fall back to a cached "we have seen this downloaded before"
    // flag so the user doesn't get nagged to redownload after restarting.
    !isBackendOnline && cachedDownloaded.has(t.id) && t.status !== "downloaded"
      ? { ...t, status: "downloaded" as const }
      : t,
  );
  const selectedTier =
    tierList.find((t) => t.id === selectedTierId) ??
    tierList.find((t) => t.selected) ??
    tierList[0] ??
    null;

  const hasImageModelReady = imageTiers.some((t) => t.status === "downloaded");

  const refreshStatus = useCallback(async () => {
    const next = await ipc.mediaAi.getStatus(undefined).catch(() => null);
    if (next) setStatus(next);
  }, []);

  const fetchImageTiers = useCallback(async (): Promise<
    ImageTierInfo[] | null
  > => {
    if (!isBackendOnline) return null;
    setImageTiersLoading(true);
    try {
      const res = await fetch(`${serverUrl}/v1/generate/image/tiers`);
      if (res.ok) {
        const data = (await res.json()) as {
          tiers: ImageTierInfo[];
          selected_tier_id: string;
        };
        setImageTiers(data.tiers);
        // Auto-collapse the picker once we confirm a model is already ready —
        // no need to show all options when generation is already possible.
        if (data.tiers.some((t) => t.status === "downloaded")) {
          setImageTiersExpanded(false);
        }
        return data.tiers;
      }
    } catch {
      // Backend not running
    } finally {
      setImageTiersLoading(false);
    }
    return null;
  }, [isBackendOnline, serverUrl]);

  const fetchTiers = useCallback(
    async (allowBackendProbe = false): Promise<ThreeDTierInfo[] | null> => {
      if (!isBackendOnline && !allowBackendProbe) return null;
      setTiersLoading(true);
      try {
        const res = await fetch(`${serverUrl}/v1/generate/3d/tiers`);
        if (res.ok) {
          const data = (await res.json()) as {
            tiers: ThreeDTierInfo[];
            selected_tier_id: string;
          };
          setTiers(data.tiers);
          setSelectedTierId((prev) => {
            if (prev && data.tiers.some((t) => t.id === prev)) return prev;
            return data.selected_tier_id;
          });
          // Persist which tiers are confirmed downloaded so we can show the
          // right status even after the backend stops.
          setCachedDownloaded((prev) => {
            const next = new Set(prev);
            for (const t of data.tiers) {
              if (t.status === "downloaded") next.add(t.id);
              else if (t.status === "not_downloaded") next.delete(t.id);
            }
            saveCachedDownloadedTiers(next);
            return next;
          });
          return data.tiers;
        }
      } catch {
        // Backend not running — silent
      } finally {
        setTiersLoading(false);
      }
      return null;
    },
    [isBackendOnline, serverUrl],
  );

  useEffect(() => {
    void refreshStatus();
    const interval = setInterval(() => void refreshStatus(), 30000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  useEffect(() => {
    if (!isBackendOnline) return;
    void fetchTiers(true);
    void fetchImageTiers();
    // Probe the 3D runtime as soon as the backend is up so the "Install 3D
    // Runtime" card appears before the user even tries to generate. Otherwise
    // they have to hit Generate, see a confusing error, and only THEN see the
    // install option.
    void (async () => {
      try {
        const res = await fetch(`${serverUrl}/v1/generate/3d/diagnostics`);
        if (!res.ok) return;
        const diag = (await res.json()) as {
          tsr_importable: boolean;
          skimage_importable: boolean;
          trimesh_importable: boolean;
          numpy_major?: number | null;
          error?: string | null;
        };
        const broken =
          !diag.tsr_importable ||
          !diag.skimage_importable ||
          !diag.trimesh_importable ||
          (diag.numpy_major !== null &&
            diag.numpy_major !== undefined &&
            diag.numpy_major < 2);
        setRuntimeMissing(broken);
        if (broken && diag.error) {
          setSetupError(diag.error);
        } else if (!broken) {
          setSetupError(null);
        }
      } catch {
        // Old backend without the diagnostics endpoint — leave the flag alone
        // and let the per-generate path catch any error.
      }
    })();
  }, [isBackendOnline, fetchTiers, fetchImageTiers, serverUrl]);

  useEffect(() => {
    return () => {
      if (downloadPollRef.current !== null) {
        window.clearInterval(downloadPollRef.current);
        downloadPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (imageDownloadPollRef.current !== null) {
        window.clearInterval(imageDownloadPollRef.current);
        imageDownloadPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isBackendOnline && inputMode === "text") {
      void fetchImageTiers();
    }
  }, [isBackendOnline, inputMode, fetchImageTiers]);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  const waitForBackendHealthy = useCallback(
    async (timeoutMs = 90_000): Promise<MediaAiStatus | null> => {
      const deadline = Date.now() + timeoutMs;
      let latest: MediaAiStatus | null = null;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        const next = await ipc.mediaAi.getStatus(undefined).catch(() => null);
        if (!next) continue;
        latest = next;
        setStatus(next);
        if (next.healthy) return next;
        if (!next.running && next.lastLog) break;
      }
      return latest;
    },
    [],
  );

  const handleStartBackend = useCallback(async () => {
    if (startingBackend) return;
    setStartingBackend(true);
    setSetupError(null);
    try {
      const startStatus = await ipc.mediaAi.startBackend(undefined);
      setStatus(startStatus);
      const healthy = startStatus.healthy
        ? startStatus
        : await waitForBackendHealthy();
      if (!healthy?.healthy) {
        const tail = healthy?.lastLog?.trim().slice(-1200);
        throw new Error(
          `Backend did not come online.${tail ? ` Last log: ${tail}` : ""}`,
        );
      }
      await fetchTiers(true);
      toast.success("Backend started");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSetupError(msg);
      toast.error(msg);
    } finally {
      setStartingBackend(false);
    }
  }, [startingBackend, waitForBackendHealthy, fetchTiers]);

  const handleSetup = async () => {
    if (setupRunning) return;
    setSetupRunning(true);
    setSetupError(null);
    try {
      const freshHw = await ipc.hardware
        .refreshProfile(undefined)
        .catch(() => null);
      const backend = freshHw?.bestMediaBackend ?? "cpu";
      const venvReady = status?.venvExists ?? false;

      // CRITICAL: stop the backend BEFORE installing on Windows. The running
      // Python process holds open file handles on numpy's DLLs, so pip can't
      // replace them — it "succeeds" leaving old binaries in place, and the
      // next backend start picks them up. That's the root cause of the
      // recurring "Expected 96, got 88" ABI error.
      const preStatus = await ipc.mediaAi
        .getStatus(undefined)
        .catch(() => null);
      if (preStatus?.running) {
        await ipc.mediaAi.stopBackend(undefined).catch(() => null);
        // Give Windows time to fully release file locks on the venv DLLs.
        // tree-kill on the backend side starts the process-tree shutdown,
        // but Windows can take a few seconds to flush file handles. Going
        // too fast here means pip silently fails to replace numpy.
        await new Promise<void>((r) => setTimeout(r, 5000));
      } else {
        // Even when our atom thinks the backend isn't running, a previous
        // backend instance from before this app restart may still be alive
        // and holding port 8000 / venv DLLs. A short wait costs us nothing
        // and prevents that race.
        await new Promise<void>((r) => setTimeout(r, 1500));
      }

      if (!venvReady) {
        // No venv yet — install the full Media AI stack (this includes
        // TripoSR via installTripoSrRuntime).
        const installResult = await ipc.mediaAi.installDependenciesForBackend({
          backend: backend === "cpu" ? undefined : backend,
        });
        if (!installResult.success) {
          throw new Error(installResult.output || "Dependency install failed");
        }
      } else {
        // venv already exists from a previous Media AI setup — just bolt the
        // TripoSR runtime on top so we don't reinstall everything.
        const installResult = await ipc.mediaAi.installThreeDRuntime({
          backend: backend === "cpu" ? undefined : backend,
        });
        if (!installResult.success) {
          throw new Error(
            installResult.output || "TripoSR runtime install failed",
          );
        }
      }

      const currentStatus = await ipc.mediaAi
        .getStatus(undefined)
        .catch(() => null);
      if (currentStatus) setStatus(currentStatus);
      const startStatus = await ipc.mediaAi.startBackend(undefined);
      setStatus(startStatus);
      const healthy = startStatus.healthy
        ? startStatus
        : await waitForBackendHealthy();
      if (!healthy?.healthy) {
        const tail = healthy?.lastLog?.trim().slice(-1200);
        throw new Error(
          `3D backend did not come online.${tail ? ` Last log: ${tail}` : ""}`,
        );
      }
      // Verify the runtime is actually importable before claiming "AI ready".
      // The diagnostics endpoint catches cases where pip silently downgraded
      // numpy, the TripoSR clone landed in the wrong place, or rembg failed
      // to install — all of which used to look "successful" until the user
      // clicked Generate and got a confusing error.
      try {
        const diagResp = await fetch(
          `${healthy.serverUrl}/v1/generate/3d/diagnostics`,
        );
        if (diagResp.ok) {
          const diag = (await diagResp.json()) as {
            tsr_importable: boolean;
            skimage_importable: boolean;
            trimesh_importable: boolean;
            numpy_version?: string | null;
            numpy_major?: number | null;
            error: string | null;
          };
          const broken =
            !diag.tsr_importable ||
            !diag.skimage_importable ||
            !diag.trimesh_importable ||
            (diag.numpy_major !== null &&
              diag.numpy_major !== undefined &&
              diag.numpy_major < 2);
          if (broken) {
            throw new Error(
              `3D runtime install incomplete: ${diag.error ?? `tsr=${diag.tsr_importable} skimage=${diag.skimage_importable} trimesh=${diag.trimesh_importable} numpy=${diag.numpy_version}`}`,
            );
          }
        }
      } catch (probeErr) {
        if (
          probeErr instanceof Error &&
          /install incomplete/.test(probeErr.message)
        ) {
          throw probeErr;
        }
        // Diagnostics endpoint missing or unreachable — fall through. The
        // first generation attempt will surface any real import error via the
        // improved threed.py error messages.
      }
      await fetchTiers(true);
      setRuntimeMissing(false);
      toast.success("3D AI ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSetupError(msg);
      toast.error(msg);
    } finally {
      setSetupRunning(false);
    }
  };

  const handleDownload = async (tierId: string) => {
    const tier = tierList.find((t) => t.id === tierId);
    setSelectedTierId(tierId);
    if (!isBackendOnline) {
      toast.info("Start the 3D backend first, then download the model.");
      return;
    }
    if (downloadPollRef.current !== null) {
      window.clearInterval(downloadPollRef.current);
      downloadPollRef.current = null;
    }
    setDownloadTierId(tierId);
    try {
      const res = await fetch(`${serverUrl}/v1/generate/3d/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier_id: tierId }),
      });
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(
          (err as { detail?: string }).detail ?? `HTTP ${res.status}`,
        );
      }
      const poll = window.setInterval(() => {
        void fetchTiers().then((next) => {
          if (!next) return;
          const t = next.find((x) => x.id === tierId);
          if (!t) return;
          if (t.status === "downloaded") {
            toast.success(`${tier?.label ?? tierId} downloaded`);
            setDownloadTierId(null);
            window.clearInterval(poll);
            if (downloadPollRef.current === poll) {
              downloadPollRef.current = null;
            }
          } else if (t.status === "not_downloaded") {
            toast.error(`${tier?.label ?? tierId} download failed`);
            setDownloadTierId(null);
            window.clearInterval(poll);
            if (downloadPollRef.current === poll) {
              downloadPollRef.current = null;
            }
          }
        });
      }, 3000);
      downloadPollRef.current = poll;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDownloadTierId(null);
      toast.error(`Download failed: ${msg}`);
    }
  };

  const handleImageModelDownload = async (tierId: string) => {
    const tier = imageTiers.find((t) => t.id === tierId);
    if (!isBackendOnline) {
      toast.info("Start the backend first, then download the model.");
      return;
    }
    if (imageDownloadPollRef.current !== null) {
      window.clearInterval(imageDownloadPollRef.current);
      imageDownloadPollRef.current = null;
    }
    setImageDownloadTierId(tierId);
    try {
      const res = await fetch(`${serverUrl}/v1/generate/image/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier_id: tierId }),
      });
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(
          (err as { detail?: string }).detail ?? `HTTP ${res.status}`,
        );
      }
      const poll = window.setInterval(() => {
        void fetchImageTiers().then((next) => {
          if (!next) return;
          const t = next.find((x) => x.id === tierId);
          if (!t) return;
          if (t.status === "downloaded") {
            toast.success(`${tier?.label ?? tierId} downloaded`);
            setImageDownloadTierId(null);
            window.clearInterval(poll);
            if (imageDownloadPollRef.current === poll) {
              imageDownloadPollRef.current = null;
            }
          } else if (t.status === "not_downloaded") {
            toast.error(`${tier?.label ?? tierId} download failed`);
            setImageDownloadTierId(null);
            window.clearInterval(poll);
            if (imageDownloadPollRef.current === poll) {
              imageDownloadPollRef.current = null;
            }
          }
        });
      }, 3000);
      imageDownloadPollRef.current = poll;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setImageDownloadTierId(null);
      toast.error(`Download failed: ${msg}`);
    }
  };

  const handleImageFileChange = (file: File | null) => {
    if (imagePreviewUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
    }
    if (file) {
      setImageFile(file);
      setImagePreviewUrl(URL.createObjectURL(file));
    } else {
      setImageFile(null);
      setImagePreviewUrl(null);
    }
  };

  const handleStopGen = () => {
    genAbortRef.current?.abort();
    genAbortRef.current = null;
    setGenStatus("idle");
    setGenStage("");
  };

  const handleGenerate = async () => {
    if (selectedTier?.status !== "downloaded") {
      toast.error("Download the TripoSR model first.");
      return;
    }
    if (!isBackendOnline) return;

    let sourceImage: Blob | null = null;
    let sourceFilename = "input.png";

    const ctrl = new AbortController();
    genAbortRef.current = ctrl;
    setGenError("");
    if (glbUrl) {
      URL.revokeObjectURL(glbUrl);
      setGlbUrl(null);
    }

    try {
      if (inputMode === "text") {
        if (!prompt.trim()) {
          toast.error("Enter a prompt to describe the 3D asset.");
          return;
        }
        setGenStatus("image-gen");
        setGenStage("Generating reference image from prompt…");
        // TripoSR reconstructs whatever it can see in the reference image, so
        // image framing directly determines 3D quality. Two key facts:
        //   1. The backend (Z-Image-Turbo) is a turbo model — it caps steps at
        //      8 and works best at CFG ~4. Sending 25/CFG7 like a normal SD
        //      model is silently clamped and just wastes the prompt.
        //   2. Long qualifier-heavy prompts confuse turbo models. A short,
        //      noun-led prompt (subject + "isolated on white background") is
        //      what they were trained on. We keep the augmentation minimal.
        const augmentedPrompt = `${prompt.trim()}, isolated on pure white background, centered`;
        const imageResponse = await fetch(`${serverUrl}/v1/generate/image`, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: augmentedPrompt,
            steps: 8,
            guidance: 4.0,
            width: 512,
            height: 512,
          }),
        });
        if (!imageResponse.ok) {
          const err = await imageResponse
            .json()
            .catch(() => ({ detail: `HTTP ${imageResponse.status}` }));
          throw new Error(
            (err as { detail?: string }).detail ??
              `HTTP ${imageResponse.status}`,
          );
        }
        const imageData = (await imageResponse.json()) as {
          image_url?: string;
        };
        if (!imageData.image_url) {
          throw new Error("Image step returned no image_url");
        }
        const fullImageUrl = `${serverUrl}${imageData.image_url}`;
        setGenImageFullUrl(fullImageUrl);
        const imgResp = await fetch(fullImageUrl, {
          signal: ctrl.signal,
        });
        if (!imgResp.ok) {
          throw new Error(`Failed to fetch reference image: ${imgResp.status}`);
        }
        sourceImage = await imgResp.blob();
        sourceFilename = "prompt.png";
      } else {
        if (!imageFile) {
          toast.error("Upload an image to convert to 3D.");
          return;
        }
        sourceImage = imageFile;
        sourceFilename = imageFile.name || "input.png";
      }

      setGenStatus("mesh-gen");
      setGenStage("Reconstructing 3D mesh with TripoSR…");

      const formData = new FormData();
      formData.append("image", sourceImage, sourceFilename);
      if (selectedTier?.id) formData.append("tier", selectedTier.id);
      // Mesh resolution is the marching-cubes grid density. Higher = more
      // surface detail (ears, fingers, fine geometry) at the cost of memory
      // and seconds-per-generation. The user-selected value is clamped on
      // the backend to TripoSR's 32-512 range.
      formData.append("mesh_resolution", String(meshResolution));
      formData.append("foreground_ratio", "0.85");

      const meshResp = await fetch(`${serverUrl}/v1/generate/3d`, {
        method: "POST",
        signal: ctrl.signal,
        body: formData,
      });
      if (!meshResp.ok) {
        const err = await meshResp
          .json()
          .catch(() => ({ detail: `HTTP ${meshResp.status}` }));
        const detail =
          (err as { detail?: string }).detail ?? `HTTP ${meshResp.status}`;
        // Any error that points at a missing / broken Python import means the
        // 3D runtime needs (re)installation. Be generous with the match so the
        // user always sees the install card when it's relevant — false
        // positives are cheap (one extra click), false negatives are painful
        // (no obvious recovery path).
        if (
          /TripoSR (is not installed|source is not on PYTHONPATH)|Cannot import TripoSR|Failed to import TripoSR|rembg is not installed|Failed to import rembg|missing dependency|Install 3D Runtime|ModuleNotFoundError|torchmcubes/i.test(
            detail,
          )
        ) {
          setRuntimeMissing(true);
        }
        throw new Error(detail);
      }
      const meshData = (await meshResp.json()) as { model_url: string };
      // Fetch GLB as blob to avoid Electron CSP issues loading .glb directly.
      const glbResp = await fetch(`${serverUrl}${meshData.model_url}`, {
        signal: ctrl.signal,
      });
      if (!glbResp.ok) {
        throw new Error(`Failed to fetch 3D model: ${glbResp.status}`);
      }
      const glbBlob = await glbResp.blob();
      const blobUrl = URL.createObjectURL(glbBlob);
      setGlbUrl(blobUrl);
      setGenStatus("done");
      setGenStage("");
      toast.success("3D model ready");

      // Auto-save to Library → Media: the 3D model and, if we generated one,
      // its reference image.
      void ipc.generatedMedia
        .saveFromUrl({
          url: `${serverUrl}${meshData.model_url}`,
          prompt: prompt.trim() || null,
          ext: ".glb",
        })
        .catch((e) => console.warn("Failed to save 3D model to library:", e));
      if (genImageFullUrl) {
        void ipc.generatedMedia
          .saveFromUrl({
            url: genImageFullUrl,
            prompt: prompt.trim() || null,
            ext: ".png",
          })
          .catch((e) => console.warn("Failed to save reference image:", e));
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setGenStatus("idle");
        setGenStage("");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setGenError(msg);
        setGenStatus("error");
        setGenStage("");
        toast.error(msg);
      }
    } finally {
      genAbortRef.current = null;
    }
  };

  const isBusy = genStatus === "image-gen" || genStatus === "mesh-gen";

  return (
    // The parent layout uses overflow-hidden, so the page must own its
    // scrolling. Without h-full + overflow-y-auto the bottom of the page
    // (Generate button, 3D viewer, Download button) is clipped on shorter
    // displays and the user can't scroll to reach it.
    <div className="relative h-full w-full overflow-y-auto">
      {!mediaSession.ready && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
          <div className="max-w-md rounded-2xl border bg-card p-6 text-center shadow-xl">
            <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin text-primary" />
            <p className="font-medium">Reserving memory for 3D generation</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {mediaSession.error ??
                "Releasing the chat model before loading the 3D pipeline…"}
            </p>
          </div>
        </div>
      )}
      <div className="container mx-auto py-6 px-6 pb-12 space-y-6 max-w-5xl">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Box className="h-6 w-6 text-primary" />
            3D Assets
          </h1>
          <p className="text-sm text-muted-foreground">
            Generate 3D models from a text prompt or a reference image —
            locally, hardware-accelerated.
          </p>
        </header>

        <div className="rounded-2xl border border-border bg-card px-4 py-2 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 text-sm">
            {isBackendOnline ? (
              <>
                <Server className="h-4 w-4 text-emerald-500" />
                <span className="font-medium">Backend online</span>
              </>
            ) : (
              <>
                <ServerOff className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Backend stopped</span>
              </>
            )}
          </div>
          <div className="flex gap-2">
            {!isBackendOnline && status?.venvExists && (
              <Button
                size="sm"
                onClick={() => void handleStartBackend()}
                disabled={startingBackend}
              >
                {startingBackend ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="mr-2 h-3.5 w-3.5" />
                )}
                {startingBackend ? "Starting…" : "Start Backend"}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshStatus()}
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        {(!status?.venvExists || runtimeMissing) && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                {runtimeMissing && status?.venvExists
                  ? "Install 3D Runtime"
                  : "Setup 3D AI"}
              </CardTitle>
              <CardDescription>
                {runtimeMissing && status?.venvExists
                  ? "TripoSR isn't installed in your Media AI Python environment yet. Click below to add it — your other Media AI setup stays untouched."
                  : "Install the TripoSR runtime and start the local backend. The first run installs Python dependencies and may take several minutes."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {setupError && (
                <div className="rounded-3xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {setupError}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void handleSetup()}
                  disabled={setupRunning}
                >
                  {setupRunning ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Wrench className="mr-2 h-4 w-4" />
                  )}
                  {setupRunning
                    ? "Installing TripoSR…"
                    : runtimeMissing && status?.venvExists
                      ? "Install TripoSR Runtime"
                      : "Setup 3D AI"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5" />
                  3D Model
                </CardTitle>
                <CardDescription>
                  Download TripoSR once, then use it for any number of
                  generations.
                </CardDescription>
              </div>
              <div className="flex gap-2">
                {status?.venvExists && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleSetup()}
                    disabled={setupRunning}
                    title="Reinstall the TripoSR Python runtime. Stops and restarts the backend automatically."
                  >
                    {setupRunning ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wrench className="mr-2 h-3.5 w-3.5" />
                    )}
                    Reinstall Runtime
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void fetchTiers(true)}
                  disabled={!isBackendOnline || tiersLoading}
                >
                  {tiersLoading ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  )}
                  Refresh
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3">
              {tierList.map((tier) => {
                const isChosen = selectedTierId === tier.id;
                const isDownloading =
                  tier.status === "downloading" || downloadTierId === tier.id;
                const statusLabel = !isBackendOnline
                  ? "Needs backend"
                  : tier.status === "downloaded"
                    ? "Downloaded"
                    : isDownloading
                      ? "Downloading"
                      : "Not downloaded";
                const statusColor =
                  tier.status === "downloaded"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                    : isDownloading
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-600"
                      : "border-border bg-transparent/50 text-muted-foreground";
                return (
                  <div
                    key={tier.id}
                    className={cn(
                      "rounded-2xl border p-3 space-y-3 transition-colors",
                      isChosen
                        ? "border-primary/40 bg-primary/5"
                        : "border-border",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        {tier.selected && (
                          <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                            Recommended
                          </span>
                        )}
                        {isChosen && (
                          <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                            Selected
                          </span>
                        )}
                        <span className="text-sm font-medium">
                          {tier.label}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                          statusColor,
                        )}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {tier.description}
                    </p>
                    <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                      <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                        {tier.vram_mb >= 1000
                          ? `${tier.vram_mb / 1000} GB VRAM`
                          : `${tier.vram_mb} MB VRAM`}
                      </span>
                      <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                        ~{(tier.download_size_mb / 1024).toFixed(2)} GB
                      </span>
                      <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                        Image → 3D
                      </span>
                      <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                        .glb output
                      </span>
                    </div>

                    {isDownloading && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] text-sky-600 font-medium">
                          <span>Download progress</span>
                          <span>
                            {tier.download_progress != null
                              ? `${tier.download_progress}%`
                              : "Preparing"}
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-sky-500/10 rounded-full overflow-hidden">
                          {tier.download_progress != null ? (
                            <div
                              className="h-full bg-sky-500 rounded-full transition-all duration-300"
                              style={{ width: `${tier.download_progress}%` }}
                            />
                          ) : (
                            <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-500" />
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={isChosen ? "default" : "outline"}
                        className="h-8 px-3 text-xs"
                        onClick={() => setSelectedTierId(tier.id)}
                      >
                        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                        {isChosen ? "Selected" : "Use Model"}
                      </Button>
                      {tier.status === "downloaded" ? (
                        <span className="inline-flex h-8 items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-2 text-xs font-medium text-emerald-600">
                          Ready to generate
                        </span>
                      ) : !isBackendOnline ? (
                        status?.venvExists ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-3 text-xs"
                            onClick={() => void handleStartBackend()}
                            disabled={startingBackend}
                          >
                            {startingBackend ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {startingBackend
                              ? "Starting…"
                              : "Start Backend to Download"}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-3 text-xs"
                            onClick={() => void handleSetup()}
                            disabled={setupRunning}
                          >
                            <Wrench className="mr-1.5 h-3.5 w-3.5" />
                            Set Up to Download
                          </Button>
                        )
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-3 text-xs"
                          onClick={() => void handleDownload(tier.id)}
                          disabled={
                            isDownloading || !tier.available_for_backend
                          }
                        >
                          {isDownloading ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {isDownloading ? "Downloading" : "Download Model"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {inputMode === "text" && (
          <Card>
            {/* Clickable header row — acts as the dropdown trigger */}
            <button
              type="button"
              onClick={() => setImageTiersExpanded((v) => !v)}
              className="w-full text-left"
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <ImageIcon className="h-5 w-5 shrink-0" />
                    <div className="min-w-0">
                      <CardTitle className="text-base">Image Model</CardTitle>
                      <CardDescription className="mt-0.5">
                        {hasImageModelReady
                          ? (() => {
                              const ready = imageTiers.find(
                                (t) => t.status === "downloaded",
                              );
                              return (
                                <span className="flex items-center gap-1.5">
                                  <span className="font-medium text-emerald-600">
                                    {ready?.label ?? "Model ready"}
                                  </span>
                                  <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-600">
                                    Ready
                                  </span>
                                </span>
                              );
                            })()
                          : "Download a model to enable text prompts"}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {imageTiersLoading && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform",
                        imageTiersExpanded && "rotate-180",
                      )}
                    />
                  </div>
                </div>
              </CardHeader>
            </button>

            {imageTiersExpanded && (
              <CardContent className="space-y-3 pt-0">
                <div className="flex items-center justify-between pb-1">
                  <p className="text-xs text-muted-foreground">
                    Text-to-3D generates a reference image first — pick a model
                    that fits your hardware.
                  </p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void fetchImageTiers();
                    }}
                    disabled={!isBackendOnline || imageTiersLoading}
                    className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 ml-3"
                  >
                    {imageTiersLoading ? "Refreshing…" : "Refresh"}
                  </button>
                </div>

                {!isBackendOnline && (
                  <p className="text-sm text-muted-foreground">
                    Start the backend to see available image models.
                  </p>
                )}
                {isBackendOnline &&
                  imageTiers.length === 0 &&
                  !imageTiersLoading && (
                    <p className="text-sm text-muted-foreground">
                      No image models found. Click Refresh to check again.
                    </p>
                  )}

                <div className="grid gap-2 md:grid-cols-2">
                  {imageTiers.map((tier) => {
                    const isDownloading =
                      tier.status === "downloading" ||
                      imageDownloadTierId === tier.id;
                    const isReady = tier.status === "downloaded";
                    return (
                      <div
                        key={tier.id}
                        className={cn(
                          "rounded-2xl border p-3 space-y-2.5 transition-colors",
                          isReady
                            ? "border-emerald-500/30 bg-emerald-500/5"
                            : isDownloading
                              ? "border-sky-500/30 bg-sky-500/5"
                              : "border-border bg-muted/10",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {tier.selected && (
                              <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                                Recommended
                              </span>
                            )}
                            <span className="text-sm font-medium truncate">
                              {tier.label}
                            </span>
                          </div>
                          <span
                            className={cn(
                              "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                              isReady
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                : isDownloading
                                  ? "border-sky-500/30 bg-sky-500/10 text-sky-600"
                                  : "border-border bg-muted/20 text-muted-foreground",
                            )}
                          >
                            {!isBackendOnline
                              ? "Needs backend"
                              : isReady
                                ? "Downloaded"
                                : isDownloading
                                  ? "Downloading"
                                  : "Not downloaded"}
                          </span>
                        </div>

                        {tier.description && (
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {tier.description}
                          </p>
                        )}

                        <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                          {/* VRAM chip */}
                          <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                            {tier.vram_mb === 0
                              ? tier.backends?.some((b) =>
                                  ["cuda", "rocm", "metal", "mps"].includes(b),
                                )
                                ? "GGUF · CPU+GPU"
                                : "CPU only"
                              : tier.vram_mb >= 1000
                                ? `${tier.vram_mb / 1000} GB VRAM`
                                : `${tier.vram_mb} MB VRAM`}
                          </span>
                          {/* For GGUF tiers show approx GPU VRAM usage alongside the
                            file size — they're roughly equal for Q4 quants */}
                          {tier.id.toLowerCase().includes("gguf") &&
                            tier.download_size_mb > 0 && (
                              <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                                ~{(tier.download_size_mb / 1024).toFixed(1)} GB
                                VRAM (GPU)
                              </span>
                            )}
                          {tier.download_size_mb > 0 && (
                            <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                              ~{(tier.download_size_mb / 1024).toFixed(1)} GB
                              {tier.id.toLowerCase().includes("gguf")
                                ? " file"
                                : " download"}
                            </span>
                          )}
                          <span className="rounded border border-border bg-transparent/50 px-1.5 py-0.5">
                            Text → Image
                          </span>
                        </div>

                        {isDownloading && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-sky-600 font-medium">
                              <span>Downloading</span>
                              <span>
                                {tier.download_progress != null
                                  ? `${tier.download_progress}%`
                                  : "Preparing…"}
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-sky-500/10 rounded-full overflow-hidden">
                              {tier.download_progress != null ? (
                                <div
                                  className="h-full bg-sky-500 rounded-full transition-all duration-300"
                                  style={{
                                    width: `${tier.download_progress}%`,
                                  }}
                                />
                              ) : (
                                <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-500" />
                              )}
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                          {isReady ? (
                            <span className="inline-flex h-8 items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-2 text-xs font-medium text-emerald-600">
                              Ready
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-3 text-xs"
                              onClick={() =>
                                void handleImageModelDownload(tier.id)
                              }
                              disabled={
                                isDownloading ||
                                !isBackendOnline ||
                                !tier.available_for_backend
                              }
                            >
                              {isDownloading ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {isDownloading
                                ? "Downloading…"
                                : "Download Model"}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            )}
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5" />
                  Generate 3D Model
                </CardTitle>
                <CardDescription>
                  {selectedTier
                    ? `Using ${selectedTier.label}`
                    : "Download a model to begin."}
                </CardDescription>
              </div>
              {!isBackendOnline && (
                <span className="text-xs text-amber-600 border border-amber-500/30 bg-amber-500/10 rounded px-2 py-1">
                  Backend offline
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedTier?.status === "not_downloaded" && (
              <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                <Download className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  Download the selected model before generating (~
                  {((selectedTier.download_size_mb ?? 1700) / 1024).toFixed(
                    2,
                  )}{" "}
                  GB).
                </span>
              </div>
            )}

            {inputMode === "text" &&
              isBackendOnline &&
              !hasImageModelReady &&
              imageTiers.length > 0 && (
                <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <Download className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Text-to-3D requires an image model to generate the reference
                    image. Download one from the <strong>Image Model</strong>{" "}
                    section above.
                  </span>
                </div>
              )}

            <div className="space-y-2">
              <Label>Input</Label>
              <div className="inline-flex rounded-2xl border border-border bg-transparent/50 p-0.5">
                <button
                  type="button"
                  onClick={() => setInputMode("text")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-3xl px-3 py-1.5 text-xs font-medium transition-colors",
                    inputMode === "text"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <TypeIcon className="h-3.5 w-3.5" />
                  Text Prompt
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode("image")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-3xl px-3 py-1.5 text-xs font-medium transition-colors",
                    inputMode === "image"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  Upload Image
                </button>
              </div>
            </div>

            {inputMode === "text" ? (
              <div className="space-y-2">
                <Label htmlFor="threed-prompt">Prompt</Label>
                <Textarea
                  id="threed-prompt"
                  placeholder="A cute red robot toy with round eyes, isometric, plain background"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                      void handleGenerate();
                  }}
                />
                <p className="text-[11px] text-muted-foreground">
                  Text prompts are first turned into a 512×512 reference image,
                  then reconstructed into 3D. TripoSR rebuilds whatever it sees,
                  so describe a single object — &ldquo;a cute red teddy bear,
                  full body, plain background&rdquo; reconstructs much better
                  than &ldquo;a teddy bear in a forest&rdquo;.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Reference Image</Label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) =>
                    handleImageFileChange(e.target.files?.[0] ?? null)
                  }
                  className="hidden"
                />
                {imagePreviewUrl ? (
                  <div className="flex items-start gap-3 rounded-2xl border border-border bg-transparent/50 p-3">
                    <img
                      src={imagePreviewUrl}
                      alt="reference"
                      className="h-24 w-24 rounded object-cover"
                    />
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-sm font-medium truncate">
                        {imageFile?.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {imageFile
                          ? `${(imageFile.size / 1024).toFixed(1)} KB`
                          : ""}
                      </p>
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="mr-1.5 h-3.5 w-3.5" />
                          Replace
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleImageFileChange(null)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-transparent/30 py-8 text-sm text-muted-foreground hover:bg-transparent/60 transition-colors"
                  >
                    <Upload className="h-6 w-6" />
                    <span>Click to upload a reference image</span>
                    <span className="text-[11px]">
                      PNG / JPG / WEBP — single object on a plain white (or
                      transparent) background. Removing the background yourself
                      before uploading gives the cleanest mesh.
                    </span>
                  </button>
                )}
              </div>
            )}

            {genStatus === "error" && (
              <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <Square className="h-4 w-4 mt-0.5 shrink-0" />
                {genError}
              </div>
            )}

            {isBusy && genStage && (
              <div className="flex items-center gap-2 rounded-2xl border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm text-sky-700 dark:text-sky-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                {genStage}
              </div>
            )}

            <div className="space-y-2">
              <Label>Quality</Label>
              <div className="inline-flex rounded-2xl border border-border bg-transparent/50 p-0.5">
                {(
                  [
                    { v: 256, label: "Fast" },
                    { v: 320, label: "Balanced" },
                    { v: 384, label: "High" },
                    { v: 512, label: "Max" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setMeshResolution(opt.v)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-3xl px-3 py-1.5 text-xs font-medium transition-colors",
                      meshResolution === opt.v
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Marching-cubes resolution ({meshResolution}). Higher captures
                fine detail like ears and fingers but takes longer and uses more
                VRAM. <span className="font-medium">Max (512)</span> needs ~6 GB
                VRAM headroom.
              </p>
            </div>

            {/* Generate button stays above the result viewer so it's always
              visible — otherwise the 420px-tall preview from a previous run
              pushes the button below the fold and looks like it's gone. */}
            <div className="flex gap-2">
              <Button
                onClick={() => void handleGenerate()}
                disabled={
                  !isBackendOnline ||
                  selectedTier?.status !== "downloaded" ||
                  isBusy ||
                  (inputMode === "text" && !prompt.trim()) ||
                  (inputMode === "text" && !hasImageModelReady) ||
                  (inputMode === "image" && !imageFile)
                }
                aria-busy={isBusy}
                className={cn(
                  "flex-1",
                  isBusy && "pointer-events-none cursor-wait",
                )}
              >
                {isBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Box className="mr-2 h-4 w-4" />
                )}
                {isBusy
                  ? genStatus === "image-gen"
                    ? "Generating reference image…"
                    : "Reconstructing 3D mesh…"
                  : selectedTier?.status !== "downloaded"
                    ? "Download 3D Model First"
                    : inputMode === "text" && !hasImageModelReady
                      ? "Download Image Model First"
                      : "Generate 3D Model"}
              </Button>
              {isBusy && (
                <Button variant="outline" onClick={handleStopGen}>
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              )}
            </div>

            {genStatus === "done" && glbUrl && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-green-600 dark:text-green-400 flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4" />
                  3D model ready
                </p>
                <Suspense
                  fallback={
                    <div className="flex h-[420px] items-center justify-center rounded-2xl border border-border bg-muted/20 text-sm text-muted-foreground">
                      Loading 3D preview…
                    </div>
                  }
                >
                  <ModelViewer url={glbUrl} />
                </Suspense>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = glbUrl;
                      a.download = `model-${Date.now()}.glb`;
                      a.click();
                    }}
                  >
                    <Download className="mr-2 h-3.5 w-3.5" />
                    Download .glb
                  </Button>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <BookMarked className="h-3.5 w-3.5" />
                    Saved to Library
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
