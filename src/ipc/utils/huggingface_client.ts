import https from "node:https";
import log from "electron-log";

const logger = log.scope("hf-client");

const HF_BASE = "https://huggingface.co";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HFSearchModel {
  id: string; // "owner/repo"
  author: string | null;
  downloads: number;
  likes: number;
  trending_score?: number;
  tags: string[];
  pipeline_tag?: string;
  library_name?: string;
  lastModified?: string;
  gated?: boolean | string;
  private?: boolean;
}

export interface HFFileSibling {
  rfilename: string;
  size?: number; // populated only when expand=siblings.size requested
  lfs?: { size?: number; oid?: string };
}

export interface HFModelDetail {
  id: string;
  author: string | null;
  cardData?: Record<string, unknown>;
  description?: string;
  siblings: HFFileSibling[];
  tags: string[];
  downloads: number;
  likes: number;
  pipeline_tag?: string;
  library_name?: string;
  lastModified?: string;
  gated?: boolean | string;
  private?: boolean;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

interface FetchOpts {
  authToken?: string;
  signal?: AbortSignal;
}

function fetchJson<T>(pathOrUrl: string, opts: FetchOpts = {}): Promise<T> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${HF_BASE}${pathOrUrl}`;
  const u = new URL(url);
  return new Promise<T>((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "OrianBuilder/1.0",
      Accept: "application/json",
    };
    if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status >= 400) {
            reject(new Error(`HF API ${status} ${url}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    if (opts.signal) {
      const onAbort = () => req.destroy(new Error("aborted"));
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end();
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SearchOpts {
  query?: string;
  /** "GGUF" filter. Pass `false` to disable. Defaults to true (GGUF only). */
  ggufOnly?: boolean;
  author?: string;
  /** Sort key: "downloads" | "likes" | "trending" | "lastModified" */
  sort?: "downloads" | "likes" | "trending" | "lastModified";
  limit?: number;
  authToken?: string;
  signal?: AbortSignal;
}

export async function searchModels(opts: SearchOpts): Promise<HFSearchModel[]> {
  const params = new URLSearchParams();
  if (opts.query) params.set("search", opts.query);
  if (opts.ggufOnly !== false) params.append("filter", "gguf");
  if (opts.author) params.set("author", opts.author);
  params.set("limit", String(opts.limit ?? 30));
  switch (opts.sort) {
    case "likes":
      params.set("sort", "likes");
      break;
    case "trending":
      params.set("sort", "trendingScore");
      break;
    case "lastModified":
      params.set("sort", "lastModified");
      break;
    case "downloads":
    default:
      params.set("sort", "downloads");
      break;
  }
  params.set("direction", "-1");
  // Lighter response — we'll fetch full details on demand
  params.append("expand", "downloads");
  params.append("expand", "likes");
  params.append("expand", "tags");
  params.append("expand", "lastModified");
  params.append("expand", "pipeline_tag");
  params.append("expand", "library_name");
  params.append("expand", "trendingScore");
  params.append("expand", "gated");
  params.append("expand", "private");

  const url = `/api/models?${params.toString()}`;
  logger.info(`HF search: ${url}`);
  const data = await fetchJson<HFSearchModel[]>(url, {
    authToken: opts.authToken,
    signal: opts.signal,
  });
  return data;
}

export async function getModelDetail(
  repoId: string,
  opts: { authToken?: string; signal?: AbortSignal } = {},
): Promise<HFModelDetail> {
  const params = new URLSearchParams();
  // Ask HF to expand siblings with file sizes (lfs.size for big GGUFs).
  params.append("blobs", "true");
  const url = `/api/models/${encodeURIComponent(repoId)}?${params.toString()}`;
  logger.info(`HF model detail: ${url}`);
  const data = await fetchJson<any>(url, opts);
  // Normalize to our type
  const siblings: HFFileSibling[] = (data.siblings ?? []).map((s: any) => ({
    rfilename: s.rfilename,
    size: typeof s.size === "number" ? s.size : undefined,
    lfs: s.lfs,
  }));
  return {
    id: data.id ?? repoId,
    author: data.author ?? repoId.split("/")[0] ?? null,
    cardData: data.cardData,
    description:
      typeof data.cardData?.description === "string"
        ? data.cardData.description
        : (data.modelInfo?.description as string | undefined),
    siblings,
    tags: data.tags ?? [],
    downloads: data.downloads ?? 0,
    likes: data.likes ?? 0,
    pipeline_tag: data.pipeline_tag,
    library_name: data.library_name,
    lastModified: data.lastModified,
    gated: data.gated,
    private: data.private,
  };
}

export interface ResolvedFile {
  url: string;
  size: number | null;
  fileName: string;
  /** True if the file requires a HF token (gated repo). */
  requiresAuth: boolean;
}

/** Compute a direct download URL via HF's resolve API (handles LFS redirects). */
export function resolveFileUrl(
  repoId: string,
  fileName: string,
  revision = "main",
): string {
  // ?download=true returns the raw bytes (post-LFS redirect) for GET.
  return `${HF_BASE}/${repoId}/resolve/${revision}/${encodeURI(fileName)}?download=true`;
}

export async function getFileSize(
  repoId: string,
  fileName: string,
  opts: { authToken?: string; signal?: AbortSignal } = {},
): Promise<number | null> {
  // Use the "tree" API to introspect the file.
  const url = `/api/models/${encodeURIComponent(repoId)}/tree/main?path=${encodeURIComponent(fileName)}`;
  try {
    const data = await fetchJson<
      Array<{ path: string; size?: number; lfs?: { size?: number } }>
    >(url, opts);
    const entry = data.find((d) => d.path === fileName);
    if (!entry) return null;
    return entry.lfs?.size ?? entry.size ?? null;
  } catch (err) {
    logger.warn(`Failed to get size for ${repoId}/${fileName}:`, err);
    return null;
  }
}

// ─── Small classification helpers (for the marketplace UI) ──────────────────

export function quantFromFileName(name: string): string | null {
  const m = name.match(/[._-](IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|F16|F32|BF16)\b/i);
  return m ? m[1].toUpperCase() : null;
}

export function paramBillionsFromName(name: string): number | null {
  const m = name.match(/[._\- (](\d+(?:\.\d+)?)\s*[bB](?:[._\- )]|$)/);
  return m ? parseFloat(m[1]) : null;
}
