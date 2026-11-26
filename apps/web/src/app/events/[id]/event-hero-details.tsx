import type { EventLocale, PublicEvent } from "@event-platform/shared-types";
import { cityName, countryName } from "../../../lib/countries";
import { INTL_LOCALES } from "../../../lib/locale";

export function eventStartDetails(event: PublicEvent, locale: EventLocale) {
  const date = new Date(event.startsAt ?? `${event.date}T${event.time.slice(0, 5)}:00Z`);
  const timeZone = event.startsAt ? event.timezone : "UTC";
  const offset = new Intl.DateTimeFormat("en", { timeZone: event.timezone, timeZoneName: "shortOffset" }).formatToParts(date).find(part => part.type === "timeZoneName")?.value ?? "GMT";
  const dateLabel = new Intl.DateTimeFormat(INTL_LOCALES[locale], { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone }).format(date);
  return {
    date: dateLabel.charAt(0).toLocaleUpperCase(INTL_LOCALES[locale]) + dateLabel.slice(1),
    time: `${event.startsAt ? new Intl.DateTimeFormat(INTL_LOCALES[locale], { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date) : event.time.slice(0, 5)} ${offset === "GMT" ? "GMT+0" : offset}`,
  };
}

/** Quiet info rows: a small grey icon, the fact, and a muted second line. */
export function EventHeroDetails({ event, locale, datePlaceholder, organizerLabel = "" }: { event: PublicEvent; locale: EventLocale; datePlaceholder?: string | undefined; organizerLabel?: string }) {
  const start = datePlaceholder ? { date: datePlaceholder, time: "" } : eventStartDetails(event, locale);
  const place = [event.city ? cityName(event.city, locale) : "", event.countryCode ? countryName(event.countryCode, locale) : ""].filter(Boolean).join(", ");
  return <ul className="event-hero-details tke-info">
    <li><InfoIcon d="M3.5 5h17v15.5h-17zM8 3v4m8-4v4M3.5 10h17" /><span><b>{start.date}</b>{start.time ? <small>{start.time}</small> : null}</span></li>
    <li><InfoIcon d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" /><a href="#location"><b>{event.address || place}</b>{place && event.address ? <small>{place}</small> : null}</a></li>
    {event.organizer?.name ? <li><InfoIcon d="M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20a7 7 0 0 1 14 0" /><a href="#organizer"><b>{event.organizer.name}{event.organizer.verified ? <span className="tke-vcheck" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg></span> : null}</b><small>{organizerLabel}</small></a></li> : null}
  </ul>;
}

function InfoIcon({ d }: { d: string }) {
  return <svg aria-hidden="true" className="tke-info-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}
