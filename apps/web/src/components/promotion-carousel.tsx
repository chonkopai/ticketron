"use client";

import type {HomepageAdEvent,HomepageAdList} from "@event-platform/shared-types";
import Link from "next/link";
import {homepageAdDate} from "./homepage-ad-banner";
import {PublicFramedAsset} from "./public-event-media";
import {cityName} from "../lib/countries";
import {localeUrl} from "../lib/locale";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "./locale-provider";

const COPY = {
  ru: { label: "Продвижение мероприятий", ad: "Реклама", placeholder: "Здесь могла бы быть реклама вашего мероприятия", loading:"Загружаем рекламу…",failed:"Не удалось загрузить рекламу",retry:"Повторить",show: "Показать баннер", more: "Подробнее", pause: "Приостановить смену баннеров", play: "Продолжить смену баннеров" },
  en: { label: "Event promotion", ad: "Advertisement", placeholder: "Your event could be featured here", loading:"Loading advertisements…",failed:"Could not load advertisements",retry:"Retry",show: "Show banner", more: "Details", pause: "Pause banner rotation", play: "Resume banner rotation" },
  kk: { label: "Іс-шараларды ілгерілету", ad: "Жарнама", placeholder: "Осы жерде іс-шараңыздың жарнамасы болуы мүмкін", loading:"Жарнама жүктелуде…",failed:"Жарнама жүктелмеді",retry:"Қайталау",show: "Баннерді көрсету", more: "Толығырақ", pause: "Баннерлер ауысуын тоқтату", play: "Баннерлер ауысуын жалғастыру" },
};
const INTERVAL = 8_000;

/** Prototype promo: full-bleed photo, dark gradient, story-style progress bars and a pause button. */
export function PromotionCarousel() {
  const locale = useLocale(), copy = COPY[locale];
  const [items, setItems] = useState<HomepageAdEvent[]>([]), [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true; const controller = new AbortController();
    const load = async () => { try { const response = await fetch(`/api/events/homepage-advertisements?locale=${locale}`, { cache: "no-store", signal: controller.signal }); if (!response.ok) throw new Error(); const data = await response.json() as HomepageAdList; if (live) { setItems(data.items); setFailed(false); } } catch { if (live) { setItems([]); setFailed(true); } } finally { if (live) setLoading(false); } };
    setLoading(true); setFailed(false); setItems([]); void load();
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(visible, 60_000); document.addEventListener("visibilitychange", visible);
    return () => { live = false; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [locale, retry]);
  const count = Math.max(1, items.length), selection = items.map(item => item.id).join(":");
  const [slide, setSlide] = useState(0);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const elapsed = useRef(0);
  useEffect(() => { setSlide(0); elapsed.current = 0; setProgress(0); }, [selection]);
  useEffect(() => { if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPaused(true); }, []);
  useEffect(() => {
    if (items.length < 2) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = now - last; last = now;
      if (!paused && !hovered && !focused && document.visibilityState === "visible") {
        elapsed.current += dt;
        if (elapsed.current >= INTERVAL) { elapsed.current = 0; setSlide(current => (current + 1) % items.length); }
        setProgress(Math.min(1, elapsed.current / INTERVAL));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [items.length, paused, hovered, focused]);
  const go = (index: number) => { elapsed.current = 0; setProgress(0); setSlide(index); };
  const active = slide % count;

  return <section aria-label={copy.label} aria-busy={loading} aria-roledescription="carousel" className="tk-promo"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className="tk-ad-tag">{copy.ad}</span>
    <div className="tk-promo-track" style={{ transform: `translateX(-${active * 100}%)` }} data-active-slide={active + 1}>
      {items.length ? items.map((event, index) => {
        const asset = event.media?.find(item => item.isCard) ?? event.media?.find(item => item.kind === "image");
        return <Link key={event.id} href={localeUrl(`/events/${event.id}`, locale)} className={`tk-slide${index === active ? " tk-active" : ""}`} aria-hidden={index !== active} tabIndex={index === active ? 0 : -1}>
          {asset ? <span className="tk-slide-media"><PublicFramedAsset asset={asset.kind === "video" && asset.posterUrl ? { ...asset, kind: "image", url: asset.posterUrl } : asset} className="h-full w-full" /></span> : event.posterUrl ? <img alt="" src={event.posterUrl} width={1600} height={900} /> : null}
          <div className="tk-slide-body">
            <span className="tk-slide-kicker">{event.city ? cityName(event.city, locale) : copy.ad}</span>
            <h2>{event.title}</h2>
            <div className="tk-slide-meta">
              <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4m8-4v4M3.5 10h17" /></svg>{homepageAdDate(event, locale)}</span>
              {event.address ? <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>{event.address}</span> : null}
            </div>
            <span className="tk-slide-cta">{copy.more}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></span>
          </div>
        </Link>;
      }) : <div className="tk-slide tk-slide-empty"><div className="tk-slide-body"><h2>{loading ? copy.loading : copy.placeholder}</h2>{failed ? <button className="tk-slide-cta" type="button" title={copy.failed} onClick={() => setRetry(n => n + 1)}>{copy.retry}</button> : null}</div></div>}
    </div>
    {items.length > 1 ? <div className="tk-promo-controls">
      {items.map((event, index) => <button key={event.id} className="tk-bar-hit" type="button" aria-label={`${copy.show} ${index + 1}`} aria-pressed={active === index} onClick={() => go(index)}><span className={`tk-bar${index === active ? " tk-active" : ""}${index < active ? " tk-done" : ""}`}><i style={{ width: index < active ? "100%" : index === active ? `${progress * 100}%` : 0 }} /></span></button>)}
      <button className="tk-pause" type="button" aria-label={paused ? copy.play : copy.pause} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="3" height="14" rx="1" fill="currentColor" /></svg>}</button>
    </div> : null}
  </section>;
}
