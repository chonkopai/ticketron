import { headers } from "next/headers";
import { isLocale } from "../lib/locale";
import { fetchServerPublicEvents } from "../lib/server-public-api";
import HomeClient from "./home-client";
import { PAGE_SIZE, readHomeQuery, readPage } from "./home-query";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Server-renders the first catalogue page; filters, paging and selection stay in the client island. */
export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  const value = (await headers()).get("x-ticket-locale");
  const locale = isLocale(value) ? value : "ru";
  const query = readHomeQuery(params);
  const page = readPage(params);
  const [result, all] = await Promise.all([
    fetchServerPublicEvents({ ...query, includeRemaining: true, page, limit: PAGE_SIZE }, locale),
    fetchServerPublicEvents({ countryCode: query.countryCode, city: query.city, page: 1, limit: 1, sort: "recent" }, locale),
  ]);
  return <HomeClient initial={result ? { query, page, result, allTotal: all?.total ?? null } : null} />;
}
