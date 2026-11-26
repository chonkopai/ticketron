"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { EventLocale } from "@event-platform/shared-types";
import { useCreationValidation } from "./creation-validation";

const INTL: Record<EventLocale, string> = { ru: "ru-RU", en: "en-GB", kk: "kk-KZ" };
const copy = {
  ru: { date: "Выберите дату", time: "Время", today: "Сегодня", prev: "Предыдущий месяц", next: "Следующий месяц", hours: "Часы", minutes: "Минуты", popular: "Часто выбирают" },
  en: { date: "Choose a date", time: "Time", today: "Today", prev: "Previous month", next: "Next month", hours: "Hours", minutes: "Minutes", popular: "Popular" },
  kk: { date: "Күнді таңдаңыз", time: "Уақыт", today: "Бүгін", prev: "Алдыңғы ай", next: "Келесі ай", hours: "Сағат", minutes: "Минут", popular: "Жиі таңдалады" },
};
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (value: string) => { const [y, m, d] = value.split("-").map(Number); return y && m && d ? new Date(y, m - 1, d) : null; };

/** Popover that closes on outside press and Escape, positioned below its trigger (or above when there is no room). */
function usePopover() {
  const [open, setOpen] = useState(false), [above, setAbove] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect(), height = panel.current.offsetHeight;
    const footer = document.querySelector(".creation-footer")?.getBoundingClientRect().height ?? 0;
    setAbove(innerHeight - footer - rect.bottom < height + 16 && rect.top > height + 80);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open]);
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); } };
  return { open, setOpen, above, root, trigger, panel, close, onKeyDown };
}

function PickTrigger({ id, label, icon, text, empty, open, validation, controls, onClick, buttonRef }: { id: string; label: string; icon: ReactNode; text: string; empty: boolean; open: boolean; validation: ReturnType<typeof useCreationValidation>; controls: string; onClick: () => void; buttonRef: React.RefObject<HTMLButtonElement | null> }) {
  return <button ref={buttonRef} id={id} type="button" className="creation-pick" data-empty={empty} aria-label={`${label}${empty ? "" : `: ${text}`}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? controls : undefined} aria-required {...validation.control} onClick={onClick}>
    <span className="creation-pick-icon" aria-hidden="true">{icon}</span><span className="creation-pick-text">{text}</span>
  </button>;
}

const calendarIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>;
const clockIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>;

export function DatePicker({ field, label, value, locale, onChange }: { field: string; label: string; value: string; locale: EventLocale; onChange: (value: string) => void }) {
  const validation = useCreationValidation(field), id = useId(), words = copy[locale], pop = usePopover();
  const selected = parse(value), today = new Date();
  const [month, setMonth] = useState(() => { const base = selected ?? today; return new Date(base.getFullYear(), base.getMonth(), 1); });
  const [focus, setFocus] = useState<string>(value || iso(today));
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => { if (pop.open) { const base = parse(value) ?? new Date(); setMonth(new Date(base.getFullYear(), base.getMonth(), 1)); setFocus(value || iso(new Date())); } }, [pop.open, value]);
  useEffect(() => { if (pop.open) grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus({ preventScroll: true }); }, [pop.open, focus, month]);
  const text = selected ? new Intl.DateTimeFormat(INTL[locale], { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(selected).replace(/\.(?=\s|$)/g, "") : words.date;
  const title = `${new Intl.DateTimeFormat(INTL[locale], { month: "long" }).format(month)} ${month.getFullYear()}`;
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(INTL[locale], { weekday: "short" }).format(new Date(2024, 0, 1 + i)).replace(".", ""));
  const offset = (month.getDay() + 6) % 7, count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array.from({ length: offset }, () => null), ...Array.from({ length: count }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  const pick = (date: Date) => { onChange(iso(date)); pop.close(); };
  const shift = (days: number) => { const base = parse(focus) ?? new Date(); base.setDate(base.getDate() + days); setFocus(iso(base)); if (base.getMonth() !== month.getMonth() || base.getFullYear() !== month.getFullYear()) setMonth(new Date(base.getFullYear(), base.getMonth(), 1)); };
  function gridKeys(event: KeyboardEvent) {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in moves) { event.preventDefault(); shift(moves[event.key]!); }
    else if (event.key === "PageUp" || event.key === "PageDown") { event.preventDefault(); const base = parse(focus) ?? new Date(); base.setMonth(base.getMonth() + (event.key === "PageUp" ? -1 : 1)); setFocus(iso(base)); setMonth(new Date(base.getFullYear(), base.getMonth(), 1)); }
  }
  return <div {...validation.wrapper} ref={pop.root} className="creation-pick-field" onKeyDown={pop.onKeyDown}>
    <PickTrigger id={id} label={label} icon={calendarIcon} text={text} empty={!selected} open={pop.open} validation={validation} controls={`${id}-pop`} buttonRef={pop.trigger} onClick={() => pop.open ? pop.close(false) : pop.setOpen(true)} />
    {pop.open ? <div ref={pop.panel} id={`${id}-pop`} role="dialog" aria-label={label} className={`creation-pop creation-calendar${pop.above ? " is-above" : ""}`}>
      <div className="creation-calendar-head"><button type="button" aria-label={words.prev} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m14.5 6-6 6 6 6"/></svg></button><b aria-live="polite">{title}</b><button type="button" aria-label={words.next} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9.5 6 6 6-6 6"/></svg></button></div>
      <div className="creation-calendar-week" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
      <div ref={grid} className="creation-calendar-grid" role="grid" onKeyDown={gridKeys}>{cells.map((date, index) => date ? <button key={iso(date)} type="button" data-day={iso(date)} tabIndex={iso(date) === focus ? 0 : -1} aria-pressed={iso(date) === value} aria-label={new Intl.DateTimeFormat(INTL[locale], { dateStyle: "full" }).format(date)} className={`${iso(date) === value ? "is-on" : ""}${iso(date) === iso(today) ? " is-today" : ""}${(date.getDay() + 6) % 7 > 4 ? " is-weekend" : ""}`} onClick={() => pick(date)}>{date.getDate()}</button> : <span key={`blank-${index}`} />)}</div>
      <div className="creation-pop-foot"><button type="button" onClick={() => pick(new Date())}>{words.today}</button></div>
    </div> : null}
    {validation.error}
  </div>;
}

export function TimePicker({ field, label, value, locale, onChange }: { field: string; label: string; value: string; locale: EventLocale; onChange: (value: string) => void }) {
  const validation = useCreationValidation(field), id = useId(), words = copy[locale], pop = usePopover();
  const [hour, minute] = value ? value.split(":").map(Number) as [number, number] : [null, null];
  const minutes = Array.from({ length: 60 }, (_, i) => i);
  const hoursList = useRef<HTMLDivElement>(null), minutesList = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!pop.open) return;
    for (const list of [hoursList.current, minutesList.current]) { const on = list?.querySelector<HTMLElement>(".is-on"); if (list && on) list.scrollTop = on.offsetTop - list.clientHeight / 2 + on.offsetHeight / 2; }
    (hoursList.current?.querySelector<HTMLButtonElement>(".is-on") ?? hoursList.current?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
  }, [pop.open]);
  const set = (h: number, m: number, done = false) => { onChange(`${pad(h)}:${pad(m)}`); if (done) pop.close(); };
  const listKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")], index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
  return <div {...validation.wrapper} ref={pop.root} className="creation-pick-field is-time" onKeyDown={pop.onKeyDown}>
    <PickTrigger id={id} label={label} icon={clockIcon} text={value || "--:--"} empty={!value} open={pop.open} validation={validation} controls={`${id}-pop`} buttonRef={pop.trigger} onClick={() => pop.open ? pop.close(false) : pop.setOpen(true)} />
    {pop.open ? <div ref={pop.panel} id={`${id}-pop`} role="dialog" aria-label={label} className={`creation-pop creation-clock${pop.above ? " is-above" : ""}`}>
      <div className="creation-clock-cols">
        <div><small>{words.hours}</small><div ref={hoursList} className="creation-clock-list" role="listbox" aria-label={words.hours} onKeyDown={listKeys}>{Array.from({ length: 24 }, (_, h) => <button key={h} type="button" role="option" aria-selected={h === hour} className={h === hour ? "is-on" : ""} onClick={() => set(h, minute ?? 0)}>{pad(h)}</button>)}</div></div>
        <div><small>{words.minutes}</small><div ref={minutesList} className="creation-clock-list" role="listbox" aria-label={words.minutes} onKeyDown={listKeys}>{minutes.map(m => <button key={m} type="button" role="option" aria-selected={m === minute} className={m === minute ? "is-on" : ""} onClick={() => set(hour ?? 19, m, true)}>{pad(m)}</button>)}</div></div>
      </div>
      <div className="creation-clock-chips"><small>{words.popular}</small><div>{["10:00", "12:00", "18:00", "19:00", "19:30", "20:00"].map(chip => <button key={chip} type="button" className={chip === value ? "is-on" : ""} onClick={() => { const [h, m] = chip.split(":").map(Number); set(h!, m!, true); }}>{chip}</button>)}</div></div>
    </div> : null}
    {validation.error}
  </div>;
}
