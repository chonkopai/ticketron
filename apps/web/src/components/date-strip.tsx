"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "./locale-provider";
import { INTL_LOCALES } from "../lib/locale";
import { KK_MONTHS, KK_WEEKDAYS, KK_WEEKDAYS_FULL } from "../lib/kazakh-date";

type DateChoice = { iso: string; day: number; weekday: string; label: string; weekend: boolean };
type MonthGroup = { key: string; label: string; days: DateChoice[] };
const DATE_STRIP_COPY = {
  ru: { choose: "Выберите дату события; прокрутите для следующих дат", previous: "Предыдущие даты", next: "Следующие даты", today: "сегодня", tomorrow: "завтра", clear: "Сбросить дату" },
  kk: { choose: "Іс-шара күнін таңдаңыз; келесі күндерге жылжытыңыз", previous: "Алдыңғы күндер", next: "Келесі күндер", today: "бүгін", tomorrow: "ертең", clear: "Күнді тазарту" },
  en: { choose: "Choose an event date; scroll for more dates", previous: "Previous dates", next: "Next dates", today: "today", tomorrow: "tomorrow", clear: "Clear date" },
} as const;

function upcomingMonths(locale: string): MonthGroup[] {
  const kazakh = locale.startsWith("kk");
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const monthName = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const fullDate = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", weekday: "long", timeZone: "UTC" });
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Almaty", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
  const value = (part: string) => Number(parts.find((item) => item.type === part)?.value);
  const start = Date.UTC(value("year"), value("month") - 1, value("day"));
  const groups: MonthGroup[] = [];

  for (let offset = 0; offset < 120; offset++) {
    const date = new Date(start + offset * 86_400_000);
    const iso = date.toISOString().slice(0, 10);
    const key = iso.slice(0, 7);
    const month = kazakh ? KK_MONTHS[date.getUTCMonth()] : monthName.format(date);
    if (groups.at(-1)?.key !== key) groups.push({ key, label: `${month}${date.getUTCFullYear() !== value("year") ? ` ${date.getUTCFullYear()}` : ""}`, days: [] });
    groups.at(-1)!.days.push({ iso, weekend: [0, 6].includes(date.getUTCDay()), day: date.getUTCDate(), weekday: kazakh ? KK_WEEKDAYS[date.getUTCDay()]! : dayName.format(date), label: kazakh ? `${date.getUTCFullYear()} жылғы ${date.getUTCDate()} ${month}, ${KK_WEEKDAYS_FULL[date.getUTCDay()]}` : fullDate.format(date) });
  }
  return groups;
}

export function DateStrip({ from, to, todaySelected, onSelect, onClear }: {
  from?: string | undefined;
  to?: string | undefined;
  todaySelected?: boolean | undefined;
  onSelect: (date: string) => void;
  onClear?: () => void;
}) {
  const locale = useLocale();
  const copy = DATE_STRIP_COPY[locale];
  const [months, setMonths] = useState<MonthGroup[]>([]);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => setMonths(upcomingMonths(INTL_LOCALES[locale])), [locale]);
  const updateScrollState = () => {
    const element = viewport.current;
    if (!element) return;
    setCanBack(element.scrollLeft > 2);
    setCanForward(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
  };

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(element);
    return () => observer.disconnect();
  }, [months]);

  const scroll = (direction: number) => viewport.current?.scrollBy({ left: direction * viewport.current.clientWidth * 0.75, behavior: "smooth" });
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.preventDefault(); element.scrollLeft += event.deltaY; } };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [months]);
  const firstDay = months[0]?.days[0]?.iso;

  const all = months.flatMap(month => month.days);
  const chip = from ? (() => { const start = all.find(day => day.iso === from); const end = to && to !== from ? all.find(day => day.iso === to) : undefined; const name = (day: DateChoice | undefined, iso: string) => day ? day.label.replace(/,?\s*\d{4}.*$/, "").replace(/^[^,]*,\s*/, "") : iso; return end ? `${name(start, from)} — ${name(end, to!)}` : name(start, from); })() : null;
  return <>
    <div className="tk-dates-view">
      <button aria-label={copy.previous} className={`tk-date-arrow tk-prev${canBack ? " tk-show" : ""}`} onClick={() => scroll(-1)} type="button"><DateArrow direction="left" /></button>
      <div aria-label={copy.choose} className="tk-dates-track" onScroll={updateScrollState} ref={viewport}>
        {months.map((month) => <span className="contents" key={month.key}>
          <span className="tk-month" aria-hidden="true">{month.label}</span>
          {month.days.map((date, index) => {
            const selected = date.iso === from || date.iso === to || (todaySelected && date.iso === firstDay);
            const inRange = Boolean(from && to && date.iso > from && date.iso < to);
            const offset = all.indexOf(date);
            return <button aria-label={date.label} aria-pressed={selected || inRange} className={`tk-day${date.weekend ? " tk-weekend" : ""}${date.iso === firstDay ? " tk-today" : ""}`} key={date.iso} onClick={() => onSelect(date.iso)} type="button" data-index={index}><span className="tk-wd">{offset === 0 ? copy.today : offset === 1 ? copy.tomorrow : date.weekday}</span><span className="tk-dn">{date.day}</span></button>;
          })}
        </span>)}
      </div>
      <button aria-label={copy.next} className={`tk-date-arrow tk-next${canForward ? " tk-show" : ""}`} onClick={() => scroll(1)} type="button"><DateArrow direction="right" /></button>
    </div>
    {chip && onClear ? <span className="tk-date-chip" style={{ display: "inline-flex" }}><span>{chip}</span><button type="button" aria-label={copy.clear} onClick={onClear}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></span> : null}
  </>;
}

function DateArrow({ direction }: { direction: "left" | "right" }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} /></svg>;
}
