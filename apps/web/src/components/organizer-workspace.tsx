"use client";

import type { AuthUser, OrganizerDashboard, OrganizerProfile } from "@event-platform/shared-types";
import Link from "next/link";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSupportText } from "./platform-support";
import type { Paged,SupportCase } from "@event-platform/shared-types";
import { ProtectedRoute } from "../app/(auth)/_components/protected-route";
import { logoutSession } from "../app/(auth)/_lib/api";
import { getSession, subscribeSession, updateSessionUser } from "../app/(auth)/_lib/session";
import { useAccountResource } from "../app/(auth)/account/use-account-resource";
import { ORGANIZER_EVENTS_COPY } from "../lib/organizer-events-copy";
import { ORGANIZER_WORKSPACE_COPY } from "../lib/organizer-workspace-copy";
import { localeUrl } from "../lib/locale";
import { AccountIcon } from "./account-icon";
import { useLocale } from "./locale-provider";

type WorkspaceState = {
  profile: ReturnType<typeof useAccountResource<OrganizerProfile>>;
  dashboard: ReturnType<typeof useAccountResource<OrganizerDashboard>>;
  user: AuthUser | null;
};
const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useOrganizerWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Organizer workspace provider is required");
  return value;
}

export function OrganizerWorkspaceShell({ active, children }: { active: "events" | "profile" | "support" | "verification"; children: ReactNode }) {
  return <main className="account-workspace organizer-workspace"><ProtectedRoute><Workspace active={active}>{children}</Workspace></ProtectedRoute></main>;
}

function Workspace({ active, children }: { active: "events" | "profile" | "support" | "verification"; children: ReactNode }) {
  const locale = useLocale(); const copy = ORGANIZER_WORKSPACE_COPY[locale]; const t=useSupportText();
  const inbox=useAccountResource<Paged<SupportCase>>("/platform-support/cases?limit=100");
  const profile = useAccountResource<OrganizerProfile>("/me/organizer-profile");
  const dashboard = useAccountResource<OrganizerDashboard>("/api/organizer/events/dashboard/summary");
  const [user, setUser] = useState<AuthUser | null>(() => getSession()?.user ?? null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    const refresh = () => setUser(getSession()?.user ?? null);
    refresh();
    return subscribeSession(refresh);
  }, []);
  useEffect(() => {
    const verified = profile.data?.verified;
    const sessionUser = getSession()?.user;
    if (sessionUser?.id === user?.id && sessionUser && typeof verified === "boolean" && sessionUser.organizerVerified !== verified) {
      updateSessionUser({ ...sessionUser, organizerVerified: verified });
    }
  }, [profile.data?.verified, user?.id]);
  async function logout() {
    if (busy) return;
    setBusy(true); setError(null);
    try { await logoutSession(); window.location.assign(localeUrl("/", locale)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : ORGANIZER_EVENTS_COPY[locale].loadFailed); setBusy(false); }
  }
  const name = profile.data?.organizationName || user?.name || ORGANIZER_EVENTS_COPY[locale].organizer;
  const complete = Boolean(profile.data?.email && profile.data?.phone);
  const navItems = [
    { key: "events", href: "/organizer/events", icon: "calendar-check", label: copy.events, extra: <span className="tko-cnt">{dashboard.data?.totalEvents ?? "…"}</span> },
    { key: "profile", href: "/organizer/profile", icon: "contact-card", label: copy.profile, extra: null },
    { key: "support", href: "/organizer/support", icon: "circle-help", label: t("Поддержка TICKET","TICKET қолдауы","TICKET support"), extra: inbox.data?.items.some(v => v.unread) ? <span className="tko-dot" aria-label={t("Новые ответы","Жаңа жауаптар","Unread replies")} /> : null },
    { key: "verification", href: "/organizer/verification", icon: "shield-check", label: t("Проверка организатора","Ұйымдастырушыны тексеру","Organizer verification"), extra: null },
  ] as const;
  // Same markup as output/organizer-redesign/organizer.html; every link and action is the live one.
  return <WorkspaceContext value={{ profile, dashboard, user }}><div className="tk-wrap"><div className="tko-org-layout organizer-layout">
    <aside className="tko-side">
      <div className="tko-panel tko-me">
        <OrganizerAvatar name={name} photoUrl={profile.data?.photoUrl ?? user?.photoUrl ?? null} className="tko-me-ava" />
        <div><b>{name}{profile.data?.verified ? <span className="tko-vcheck" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg></span> : null}</b><small>{ORGANIZER_EVENTS_COPY[locale].organizer}</small></div>
      </div>
      <nav className="tko-panel tko-nav" aria-label={copy.sections}>
        {navItems.map(item => <Link key={item.key} className={active === item.key ? "tko-on" : ""} aria-current={active === item.key ? "page" : undefined} href={localeUrl(item.href, locale)}><AccountIcon name={item.icon} />{item.label}{item.extra}</Link>)}
        <hr />
        <Link href={localeUrl("/account?tab=profile", locale)}><AccountIcon name="user-round" />{copy.guest}</Link>
        <button className="tko-out" type="button" disabled={busy} onClick={() => void logout()}><AccountIcon name="log-out" />{copy.logout}</button>
      </nav>
      {profile.data && !profile.data.verified ? <div className="tko-notice"><b><AccountIcon name="shield-check" />{t("Проверка организатора","Ұйымдастырушыны тексеру","Organizer verification")}</b><p>{t("Подайте документы, чтобы получить отметку рядом с именем.","Атыңыздың жанында белгі алу үшін құжат жіберіңіз.","Submit your documents to receive a badge beside your name.")}</p><Link href={localeUrl("/organizer/verification",locale)}>{t("Открыть заявку","Өтінішті ашу","Open application")} <AccountIcon name="arrow-right" /></Link></div> : null}
      {profile.data && !complete ? <div className="tko-notice"><b><AccountIcon name="info" />{copy.incomplete}</b><p>{copy.contactHint}</p><Link href={localeUrl("/organizer/profile", locale)}>{copy.fillProfile} <AccountIcon name="arrow-right" /></Link></div> : profile.error ? <OrganizerResourceError message={profile.error} onRetry={profile.retry} /> : null}
      <nav className="tko-mtabs" aria-label={copy.sections}>
        {navItems.map(item => <Link key={item.key} className={active === item.key ? "tko-on" : ""} href={localeUrl(item.href, locale)}><AccountIcon name={item.icon} />{item.label}</Link>)}
        <Link href={localeUrl("/account?tab=profile", locale)}><AccountIcon name="user-round" />{copy.guest}</Link>
      </nav>
    </aside>
    <div className="account-content organizer-content tko-content">{error ? <OrganizerResourceError message={error} /> : null}{children}</div>
  </div></div></WorkspaceContext>;
}

export function OrganizerAvatar({ name, photoUrl, className = "" }: { name: string; photoUrl: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoUrl]);
  const source = photoUrl ? new URL(photoUrl, process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").toString() : null;
  return <span aria-hidden="true" className={`account-avatar ${className}`}>{source && !failed ? <img alt="" src={source} width={48} height={48} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : name.slice(0, 1).toUpperCase() || "O"}</span>;
}

/** Existing event-creation SVGs retain their shapes and intrinsic dimensions. */
export function OrganizerIcon({ name }: { name: string }) {
  if (["calendar-days", "upload", "lock-keyhole"].includes(name)) return <img aria-hidden="true" alt="" className="organizer-existing-icon" src={`/event-creation/${name}.svg`} width={name === "calendar-days" ? 19 : name === "upload" ? 17 : 15} height={name === "calendar-days" ? 19 : name === "upload" ? 17 : 15} />;
  return <AccountIcon name={name} />;
}

export function OrganizerResourceError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const copy = ORGANIZER_WORKSPACE_COPY[useLocale()];
  return <div className="organizer-resource-error" role="alert"><p>{message}</p>{onRetry ? <button className="account-text-link" type="button" onClick={onRetry}>{copy.retry}</button> : null}</div>;
}
