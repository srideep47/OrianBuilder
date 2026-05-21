/**
 * Renderer-side REST client for the Watchdog backend.
 *
 * The FastAPI server bound to http://127.0.0.1:8765 is loopback-only and
 * CORS-permissive, so the renderer can fetch it directly without going
 * through IPC for every CRUD call. We only use IPC for lifecycle (setup /
 * start / stop / status) and for discovering the base URL.
 *
 * Errors are normalised to `Error` with the FastAPI `detail` field as the
 * message when present.
 */

export interface Website {
  id: number;
  url: string;
  last_content_hash: string | null;
  summary: string | null;
}

export interface WebsiteUpdate {
  id: number;
  website_id: number;
  update_text: string;
  timestamp: string;
}

export interface WebsiteItem {
  title: string;
  url: string;
}

export interface Product {
  id: number;
  url: string;
  current_price: number | null;
  current_currency: string | null;
  target_price: number | null;
  target_currency: string | null;
  image_url: string | null;
  rating: number | null;
  rating_count: number | null;
}

export interface PricePoint {
  id: number;
  product_id: number;
  price: number;
  timestamp: string;
}

async function request<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.detail === "string") message = parsed.detail;
      else if (parsed && parsed.detail) message = JSON.stringify(parsed.detail);
    } catch {
      /* raw text already assigned */
    }
    throw new Error(message || `Request failed: ${response.status}`);
  }
  // Some endpoints (DELETE) return tiny JSON; .json() is still cheap.
  return (await response.json()) as T;
}

export function createWatchdogApi(baseUrl: string) {
  return {
    listWebsites: () => request<Website[]>(baseUrl, "/websites"),
    addWebsite: (url: string) =>
      request<Website>(baseUrl, "/websites", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    removeWebsite: (id: number) =>
      request<{ deleted: boolean }>(baseUrl, `/websites/${id}`, {
        method: "DELETE",
      }),
    checkWebsite: (id: number) =>
      request<Website>(baseUrl, `/websites/${id}/check`, { method: "POST" }),
    websiteUpdates: (id: number) =>
      request<WebsiteUpdate[]>(baseUrl, `/websites/${id}/updates`),
    websiteItems: (id: number) =>
      request<WebsiteItem[]>(baseUrl, `/websites/${id}/items`),
    listProducts: () => request<Product[]>(baseUrl, "/products"),
    addProduct: (url: string, targetPrice?: number | null) =>
      request<Product>(baseUrl, "/products", {
        method: "POST",
        body: JSON.stringify({ url, target_price: targetPrice ?? null }),
      }),
    removeProduct: (id: number) =>
      request<{ deleted: boolean }>(baseUrl, `/products/${id}`, {
        method: "DELETE",
      }),
    checkProduct: (id: number) =>
      request<Product>(baseUrl, `/products/${id}/check`, { method: "POST" }),
    productHistory: (id: number) =>
      request<PricePoint[]>(baseUrl, `/products/${id}/history`),
  };
}

export type WatchdogApi = ReturnType<typeof createWatchdogApi>;
