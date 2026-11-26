import type { Metadata } from "next";
import { headers } from "next/headers";
import sanitizeHtml from "sanitize-html";
import { richDescriptionBody } from "@event-platform/shared-types";
import { EventDescription } from "../../../components/event-description";
import { isLocale, localeUrl } from "../../../lib/locale";
import { fetchServerPublicEvent, fetchServerVenueLayout } from "../../../lib/server-public-api";
import PublicEventClient from "./event-client";

// Browser-facing origin: absolute OpenGraph URLs must point at the public site.
const PUBLIC_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function requestLocale() {
  const value = (await headers()).get("x-ticket-locale");
  return isLocale(value) ? value : "ru";
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const requestHeaders = await headers();
  const locale = await requestLocale();
  const path = requestHeaders.get("x-ticket-path") ?? `/events/${id}`;
  const alternates = { languages: {
    ru: localeUrl(path, "ru"),
    kk: localeUrl(path, "kk"),
    en: localeUrl(path, "en"),
    "x-default": localeUrl(path, "ru"),
  } };
  // Same URL and options as the page render, so Next memoizes it into one API call.
  const event = await fetchServerPublicEvent(id, locale);
  if (!event) return { alternates };
  const fallback = event.contentLocale && event.contentLocale !== locale ? ` [${event.contentLocale.toUpperCase()}]` : "";
  const description = event.description ? sanitizeHtml(richDescriptionBody(event.description) ?? event.description, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim().slice(0, 160) : undefined;
  return {
    title: `${event.title}${fallback} | TICKET`,
    description,
    alternates,
    openGraph: { title: `${event.title}${fallback}`, description, images: event.posterUrl ? [new URL(event.posterUrl, PUBLIC_ORIGIN).toString()] : [] },
  };
}

export default async function PublicEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await requestLocale();
  const [event, layout] = await Promise.all([fetchServerPublicEvent(id, locale), fetchServerVenueLayout(id, locale)]);
  // The description is sanitized here so sanitize-html stays out of the public client bundle.
  const description = event?.creationVersion === 2 && event.description ? <EventDescription value={event.description} /> : undefined;
  return <PublicEventClient id={id} initial={event ? { event, layout, locale } : undefined} description={description} />;
}
