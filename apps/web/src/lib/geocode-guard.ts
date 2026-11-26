/**
 * Abuse limits for the server-side geocoder proxy (`/api/address/geocode`), which
 * spends the paid Yandex key. Counters and cache are PER PROCESS: each web
 * instance keeps its own, and a restart clears them.
 */
export const GEOCODE_MAX_QUERY_LENGTH = 200;
const LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
const MAX_CLIENTS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 500;

const windows = new Map<string, { count: number; until: number }>();
const cache = new Map<string, { body: string; until: number }>();

/** Caddy, the public edge, replaces `X-Forwarded-For` with the real peer, so the
 * rightmost entry is the client; anything to its left is client-supplied. */
export function geocodeClientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "direct";
}

/** Browsers send `Origin` on every POST; without it, require `Sec-Fetch-Site: same-origin`. */
export function isSameOriginRequest(request: Request, allowedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === allowedOrigin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** Counts one request; true once the client exceeded its per-minute budget. */
export function geocodeRateLimited(client: string, now = Date.now()): boolean {
  // Same-length windows in insertion order: expired ones are always at the front.
  for (const [key, window] of windows) {
    if (window.until > now) break;
    windows.delete(key);
  }
  let window = windows.get(client);
  if (!window) {
    // Full: evict the oldest window instead of refusing every new client.
    if (windows.size >= MAX_CLIENTS) windows.delete(windows.keys().next().value!);
    window = { count: 0, until: now + WINDOW_MS };
    windows.set(client, window);
  }
  return ++window.count > LIMIT_PER_MINUTE;
}

export function cachedGeocode(key: string, now = Date.now()): string | undefined {
  const entry = cache.get(key);
  if (entry && entry.until > now) return entry.body;
  if (entry) cache.delete(key);
  return undefined;
}

export function rememberGeocode(key: string, body: string, now = Date.now()): void {
  cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { body, until: now + CACHE_TTL_MS });
}

/** Test support: clears counters and cache. */
export function resetGeocodeGuards(): void {
  windows.clear();
  cache.clear();
}
