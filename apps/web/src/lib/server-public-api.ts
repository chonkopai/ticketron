// Server-only reads of public catalogue data. Server code must reach the API
// directly (API_INTERNAL_URL): NEXT_PUBLIC_API_URL is the *web* origin, and
// `/events/*` on the web origin is the event page itself.
import type { EventLocale, PublicEvent, PublicEventList, PublicVenueLayout } from "@event-platform/shared-types";
import { publicEventsSearchParams, type PublicEventsQuery } from "./public-events";

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

/**
 * Public, cookie-free responses are shared across visitors through the Next data
 * cache for a few seconds. Live availability is re-polled by the client and
 * every sale is re-validated by the API, so a short staleness only affects the
 * first paint.
 */
const CATALOG_REVALIDATE_SECONDS = 15;
const EVENT_REVALIDATE_SECONDS = 10;

async function readJson<T>(path: string, revalidate: number): Promise<T | null> {
  try {
    const response = await fetch(new URL(path, API_INTERNAL_URL), {
      headers: { accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = await response.text();
    return body.trim() ? JSON.parse(body) as T : null;
  } catch {
    return null;
  }
}

export function fetchServerPublicEvent(id: string, locale: EventLocale): Promise<PublicEvent | null> {
  return readJson<PublicEvent>(`/events/${encodeURIComponent(id)}?locale=${locale}`, EVENT_REVALIDATE_SECONDS);
}

export function fetchServerVenueLayout(id: string, locale: EventLocale): Promise<PublicVenueLayout | null> {
  return readJson<PublicVenueLayout>(`/events/${encodeURIComponent(id)}/venue-layout?locale=${locale}`, EVENT_REVALIDATE_SECONDS);
}

export function fetchServerPublicEvents(query: PublicEventsQuery, locale: EventLocale): Promise<PublicEventList | null> {
  return readJson<PublicEventList>(`/events?${publicEventsSearchParams(query, locale).toString()}`, CATALOG_REVALIDATE_SECONDS);
}
