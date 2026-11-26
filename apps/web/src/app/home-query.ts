// Pure catalogue URL parsing, shared by the server page and the client island.
import { EVENT_CATEGORIES, type EventCategory, type PublicEventList } from "@event-platform/shared-types";
import type { PublicEventsQuery } from "../lib/public-events";
import { validCountryCode } from "../lib/catalog-location";

export const PAGE_SIZE = 18;

export const DEFAULT_QUERY: PublicEventsQuery = { sort: "soonest" };

export function readPage(params: URLSearchParams): number {
  const raw = params.get("page");
  return raw && /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : 1;
}

export function readHomeQuery(params: URLSearchParams): PublicEventsQuery {
  const category = params.get("category");
  const datePreset = params.get("datePreset");
  const date = (value: string | null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  const free = params.get("free") === "true";
  const price = (value: string | null) => value !== null && /^\d+$/.test(value) && Number(value) <= 1_000_000 ? Number(value) : undefined;
  return {
    countryCode: validCountryCode(params.get("countryCode")) ?? undefined,
    city: params.get("city")?.trim() || undefined,
    sort: params.get("sort") === "recent" ? "recent" : params.get("sort") === "popular" ? "popular" : "soonest",
    timeOfDay: (["morning", "day", "evening", "night"] as const).find(value => value === params.get("timeOfDay")),
    search: params.get("search")?.trim() || undefined,
    category: EVENT_CATEGORIES.includes(category as EventCategory) ? category! : undefined,
    datePreset: datePreset === "today" || datePreset === "weekend" ? datePreset : undefined,
    from: date(params.get("from")),
    to: date(params.get("to")),
    free: free || undefined,
    minPrice: price(params.get("minPrice")),
    maxPrice: price(params.get("maxPrice")),
  };
}

/** Initial catalogue payload rendered on the server. */
export type HomeInitialData = {
  query: PublicEventsQuery;
  page: number;
  result: PublicEventList;
  allTotal: number | null;
};

export function sameHomeQuery(left: PublicEventsQuery, right: PublicEventsQuery): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<keyof PublicEventsQuery>);
  return [...keys].every(key => left[key] === right[key]);
}
