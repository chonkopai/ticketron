import type { EventLocale, PublicEventList, PublicEventSummary, PublicVenueLayout } from "@event-platform/shared-types";
import { localeFromBrowser } from "./locale";

export interface PublicEventsQuery {
  timeOfDay?: "morning" | "day" | "evening" | "night" | undefined;
  page?: number | undefined;
  limit?: number | undefined;
  sort?: "recent" | "popular" | "soonest" | undefined;
  includeRemaining?: boolean | undefined;
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  city?: string | undefined;
  countryCode?: string | undefined;
  category?: string | undefined;
  datePreset?: "today" | "weekend" | undefined;
  free?: boolean | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
}

/** Query string for `GET /events`; shared by the browser client and server rendering. */
export function publicEventsSearchParams(query: PublicEventsQuery, locale: EventLocale): URLSearchParams {
  const params = new URLSearchParams();
  params.set("locale", locale);
  if (query.page) params.set("page", String(query.page));
  if (query.limit) params.set("limit", String(query.limit));
  if (query.timeOfDay) params.set("timeOfDay", query.timeOfDay);
  if (query.sort) params.set("sort", query.sort);
  if (query.includeRemaining) params.set("includeRemaining", "true");
  if (query.search?.trim()) params.set("search", query.search.trim());
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.city?.trim()) params.set("city", query.city.trim());
  if (query.countryCode) params.set("countryCode", query.countryCode);
  if (query.category) params.set("category", query.category);
  if (query.datePreset) params.set("datePreset", query.datePreset);
  if (query.free !== undefined) params.set("free", String(query.free));
  if (query.minPrice !== undefined) params.set("minPrice", String(query.minPrice));
  if (query.maxPrice !== undefined) params.set("maxPrice", String(query.maxPrice));
  return params;
}

export async function fetchPublicEvents(query: PublicEventsQuery = {}): Promise<PublicEventList> {
  const params = publicEventsSearchParams(query, localeFromBrowser());
  const response = await fetch(`/api/events?${params.toString()}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 404 ? "EVENTS_NOT_FOUND" : "EVENTS_UNAVAILABLE");
  return response.json() as Promise<PublicEventList>;
}

export async function fetchPublicEventSummary(id: string): Promise<PublicEventSummary | null> {
  const response = await fetch(`/api/events/${encodeURIComponent(id)}/summary?locale=${localeFromBrowser()}`, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("EVENT_UNAVAILABLE");
  return response.json() as Promise<PublicEventSummary | null>;
}

export async function fetchPublicVenueLayout(id: string): Promise<PublicVenueLayout | null> {
  const response = await fetch(`/api/events/${encodeURIComponent(id)}/venue-layout?locale=${localeFromBrowser()}`, { cache: "no-store" });
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new Error("VENUE_LAYOUT_UNAVAILABLE");
  // Ticket-only events can return an empty 200 response when no layout exists.
  const body = await response.text();
  return body.trim() ? JSON.parse(body) as PublicVenueLayout : null;
}
