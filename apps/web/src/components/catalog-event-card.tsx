"use client";
import type { EventLocale, PublicEventSummary } from "@event-platform/shared-types";
import Link from "next/link";
import { HOME_COPY } from "../app/home-copy";
import { formatCatalogPrice as formatPrice } from "../lib/catalog-event-price";
import { INTL_LOCALES } from "../lib/locale";
import { CategoryIcon } from "./category-icon";
import { ContentLanguageNote } from "./content-language-note";
import { useDisplayCurrency } from "./currency-provider";
import { FavoriteButton } from "./favorite-button";
import { useLocale } from "./locale-provider";
import { EventCardMedia } from "./public-event-media";

function useHomeCopy() { return HOME_COPY[useLocale()]; }

/** The catalog event card from the home page, shared with favourites and similar events. */
export function CatalogEventCard({ event, index, newTab = true }: { event: PublicEventSummary; index: number; newTab?: boolean }) {
  const copy = useHomeCopy();
  const locale = useLocale();
  const { formatMoney } = useDisplayCurrency();
  const date = new Date(`${event.date}T00:00:00Z`);
  const month = new Intl.DateTimeFormat(INTL_LOCALES[locale], { month: "short", timeZone: "UTC" }).format(date).replace(".", "");
  const weekday = new Intl.DateTimeFormat(INTL_LOCALES[locale], { weekday: "short", timeZone: "UTC" }).format(date);
  const free = event.startingAmount === 0 && event.startingPrices.length <= 1;
  const price = free ? copy.free : formatPrice(event, formatMoney, locale);
  const fromWord = `${copy.from} `;
  const units = [copy.ticketUnit, copy.seatUnit, copy.tableUnit].map(unit => ` ${unit}`);
  const amount = (price.startsWith(fromWord) ? price.slice(fromWord.length) : price).split(` · ${fromWord}`).map(part => units.reduce((text, unit) => text.endsWith(unit) ? text.slice(0, -unit.length) : text, part)).join(" · ");
  const buy = ({ ru: ["Купить", "Записаться"], kk: ["Сатып алу", "Тіркелу"], en: ["Buy", "Register"] } as const)[locale];
  return <article className="tk-card ticket-event-card" style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
    <Link href={`/events/${event.id}`} {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      <div className="tk-media">
        <EventCardMedia asset={event.media?.find(asset => asset.isCard)} posterUrl={event.posterUrl} />
        <span className="tk-date-badge" aria-label={formatEventDate(event, locale)}><b>{date.getUTCDate()}</b><small>{month}</small></span>
        <span className="tk-cat-tag"><CategoryIcon category={event.category} />{copy.categories[event.category]}</span>
      </div>
      <div className="tk-body">
        <h3>{event.title}</h3>
        <ContentLanguageNote contentLocale={event.contentLocale} />
        <div className="tk-meta">
          <span><ClockIcon /><em>{weekday}, {event.time.slice(0, 5)}</em></span>
          <span className="tk-venue"><PinIcon /><em>{event.address}</em></span>
        </div>
        <div className="tk-foot">
          <span className={`tk-price${free ? " tk-free" : ""}`}>{amount !== price ? <small>{copy.from}</small> : null}{amount}<span className="tk-age">{event.ageRestriction}+</span></span>
          <span className="tk-buy">{free ? buy[1] : buy[0]}<ArrowIcon /></span>
        </div>
      </div>
    </Link>
    <FavoriteButton eventId={event.id} compact />
  </article>;
}

function formatEventDate(event: PublicEventSummary, locale: EventLocale): string { const date = new Date(`${event.date}T00:00:00Z`); const formatted = new Intl.DateTimeFormat(INTL_LOCALES[locale], { day: "numeric", month: "long", timeZone: "UTC" }).format(date); return `${formatted}, ${event.time.slice(0, 5)}`; }
function PinIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>; }
function ClockIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>; }
function ArrowIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>; }
