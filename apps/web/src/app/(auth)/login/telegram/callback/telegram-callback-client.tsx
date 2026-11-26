"use client";

import type { TelegramOidcCompleteResponse } from "@event-platform/shared-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../../../../components/locale-provider";
import { localeUrl } from "../../../../../lib/locale";
import { saveSession } from "../../../_lib/session";
import { completeTelegramLogin, pendingTelegramLogin } from "../../../_lib/telegram-oidc";
import { TELEGRAM_AUTH_COPY } from "../../../_lib/telegram-auth-copy";

export function TelegramCallbackClient() {
  const locale = useLocale();
  const copy = TELEGRAM_AUTH_COPY[locale];
  const router = useRouter();
  const completion = useRef<Promise<TelegramOidcCompleteResponse> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState("/");

  useEffect(() => {
    let active = true;
    if (!completion.current) {
      const attempt = pendingTelegramLogin();
      setReturnTo(attempt?.returnTo ?? localeUrl("/", locale));
      const search = window.location.search;
      // Remove code/state before other navigation; a reload safely asks for a new attempt.
      window.history.replaceState(window.history.state, "", localeUrl("/login/telegram/callback", attempt?.locale ?? locale));
      completion.current = completeTelegramLogin(search);
    }
    // Reuse the same promise across Strict Mode effects; never exchange a code twice.
    void completion.current.then(result => {
      if (!active) return;
      saveSession(result.session);
      router.replace(result.returnTo);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : copy.failed); });
    return () => { active = false; };
  }, [copy.failed, locale, router]);

  const restart = localeUrl(`/login?returnTo=${encodeURIComponent(returnTo)}`, locale);
  return <main className="tk-status-page">
    <section className="tk-status-card" aria-labelledby="telegram-callback-title">
      <span className={`tk-status-ico ${error ? "is-error" : "is-wait"}`} aria-hidden="true">{error ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 8v5m0 3.5v.5"/><circle cx="12" cy="12" r="9"/></svg> : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.4 4.6 2.9 11.7c-1.3.5-1.3 1.2-.2 1.6l4.7 1.5 1.8 5.6c.2.6.1.9.8.9.5 0 .7-.2 1-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.8c.3-1.3-.5-1.9-1.5-1.4Z"/></svg>}</span>
      <h1 id="telegram-callback-title">{copy.title}</h1>
      {error ? <>
        <p role="alert" className="tk-status-text is-error">{error}</p>
        <div className="tk-status-actions">
          <Link className="tk-btn tk-btn-primary" href={restart}>{copy.retry}</Link>
          <Link className="tk-btn tk-btn-ghost" href={`${restart}&telegram=phone`}>{copy.phone}</Link>
        </div>
      </> : <p className="tk-status-text" role="status"><span className="tk-status-spinner" aria-hidden="true"/>{copy.verifying}</p>}
      <Link className="tk-status-link" href={restart}>{copy.back}</Link>
    </section>
  </main>;
}
