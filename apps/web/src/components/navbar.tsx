"use client";
import { ThemeToggle } from "./theme-toggle";
import { usesStandaloneHeader } from "../lib/theme";

import type { AuthUser } from "@event-platform/shared-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { getSession, subscribeSession } from "../app/(auth)/_lib/session";
import { OptionPicker } from "./option-picker";
import { HeaderNotifications } from "./header-notifications";
import { HeaderSearch } from "./header-search";
import { CatalogLocationPicker } from "./catalog-location-picker";
import { useLocale } from "./locale-provider";
import { localeUrl } from "../lib/locale";
import type { EventLocale } from "@event-platform/shared-types";
import { NAV_COPY } from "./navbar-copy";

const LANGUAGE_OPTIONS = [
  { value: "ru", label: "Русский", compactLabel: "RU" },
  { value: "kk", label: "Қазақша", compactLabel: "KZ" },
  { value: "en", label: "English", compactLabel: "EN" },
];

export function Navbar() {
  const locale = useLocale();
  const copy = NAV_COPY[locale];
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => {
    const refresh = () => setUser(getSession()?.user ?? null);
    refresh();
    return subscribeSession(refresh);
  }, []);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const sync = () => setScrolled(window.scrollY > 4);
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, []);
  useEffect(() => setPhotoFailed(false), [user?.photoUrl]);
  useEffect(() => {
    // "/" jumps to search, as in the prototype.
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const input = document.getElementById(window.innerWidth > 860 ? "tk-q" : "tk-q2") as HTMLInputElement | null;
      if (!input) return;
      event.preventDefault(); setOpen(true); input.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  if (usesStandaloneHeader(pathname)) return null;

  const createHref = localeUrl("/events/create", locale);

  function switchLocale(value: string): void {
    if (value !== "ru" && value !== "kk" && value !== "en") return;
    window.location.assign(localeUrl(`${window.location.pathname}${window.location.search}${window.location.hash}`, value as EventLocale));
  }

  const initials = user?.name?.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  const photoUrl = user?.photoUrl ? new URL(user.photoUrl, process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").toString() : null;
  const avatar = photoUrl && !photoFailed ? <img alt="" onError={() => setPhotoFailed(true)} src={photoUrl} width={30} height={30} /> : initials ? <b>{initials}</b> : <UserIcon />;

  // Same markup as the prototype top bar (output/home-redesign/home.html); every control keeps its existing logic.
  return <header className={`tk-topbar${scrolled ? " tk-scrolled" : ""}`}>
    <div className="tk-wrap">
      <div className="tk-topbar-row">
        <Link className="tk-brand" href={localeUrl("/", locale)} aria-label="TICKET">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v3c-1.7 0-3 1.3-3 3s1.3 3 3 3v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3c1.7 0 3-1.3 3-3s-1.3-3-3-3V6a1 1 0 0 1 1-1Z" /><path d="M13 5v2m0 4v2m0 4v2" /></svg>
          <span>TICKET</span>
        </Link>
        <div className="tk-loc-host"><CatalogLocationPicker /></div>
        <HeaderSearch variant="topbar" inputId="tk-q" />
        <div className="tk-actions">
          <button className="tk-icon-btn tk-search-mobile" type="button" aria-label={copy.catalog} aria-expanded={open} onClick={() => setOpen(value => !value)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          </button>
          <Link className="tk-create" href={createHref} aria-label={copy.createEvent}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            <span>{copy.createEvent}</span>
          </Link>
          <span className="tk-sep" aria-hidden="true" />
          <div className="tk-lang"><OptionPicker appearance="bare" label={copy.language} value={locale} options={LANGUAGE_OPTIONS} onChange={switchLocale} /></div>
          {user ? <HeaderNotifications key={user.id} variant="topbar" /> : <GuestNotifications />}
          <Link className="tk-icon-btn" href={localeUrl("/favorites", locale)} aria-label={copy.favorites} title={copy.favorites} aria-current={pathname === "/favorites" ? "page" : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20.2s-7.8-4.6-7.8-10.4A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 7.8 2.8c0 5.8-7.8 10.4-7.8 10.4Z" /></svg>
          </Link>
          <div className="tk-theme"><ThemeToggle /></div>
          <Link className="tk-account" href={localeUrl(user ? "/account" : "/login", locale)}>
            <span className="tk-avatar">{avatar}</span>
            <span>{user ? copy.account : copy.account}</span>
          </Link>
        </div>
      </div>
      <div className={`tk-search-row${open ? " tk-open" : ""}`}><HeaderSearch variant="topbar" inputId="tk-q2" /></div>
    </div>
  </header>;
}

function UserIcon() { return <svg aria-hidden="true" className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8"/><path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"/></svg>; }

const GUEST_NOTIFICATIONS = {
  ru: { title: "Уведомления", text: "Войдите, чтобы видеть билеты, напоминания и ответы организаторов.", action: "Войти" },
  kk: { title: "Хабарландырулар", text: "Билеттерді, еске салуларды және ұйымдастырушы жауаптарын көру үшін кіріңіз.", action: "Кіру" },
  en: { title: "Notifications", text: "Sign in to see tickets, reminders and organizer replies.", action: "Sign in" },
} as const;

/** Same bell and card as the signed-in version; guests get a sign-in prompt instead of an inbox. */
function GuestNotifications() {
  const locale = useLocale();
  const copy = GUEST_NOTIFICATIONS[locale];
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="tk-notif-wrap" ref={root}>
    <button type="button" className="tk-icon-btn tk-notif-btn" aria-label={copy.title} title={copy.title} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15 6 8.5Z" /><path d="M10 20a2.2 2.2 0 0 0 4 0" /></svg>
    </button>
    {open ? <div className="tk-notif-pop" role="dialog" aria-label={copy.title}>
      <div className="tk-notif-head"><b>{copy.title}</b></div>
      <p className="tk-notif-guest">{copy.text}</p>
      <Link className="tk-notif-foot" href={localeUrl("/login", locale)} onClick={() => setOpen(false)}>{copy.action}</Link>
    </div> : null}
  </div>;
}
