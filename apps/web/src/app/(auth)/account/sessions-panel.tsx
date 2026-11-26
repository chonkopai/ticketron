"use client";

import type { AccountSessionList } from "@event-platform/shared-types";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiRequest } from "../_lib/api";
import { clearSession } from "../_lib/session";
import { useLocale } from "../../../components/locale-provider";
import { localeUrl } from "../../../lib/locale";

const SESSIONS_COPY = {
  ru: { title: "Сеансы", intro: "Выйдите на всех устройствах, если потеряли телефон или входили с чужого компьютера.", active: "Активных сеансов", signOutAll: "Выйти на всех устройствах", confirm: "Выйти на всех устройствах, включая это?", failed: "Не удалось завершить сеансы." },
  kk: { title: "Сеанстар", intro: "Телефонды жоғалтсаңыз немесе бөтен компьютерден кірсеңіз, барлық құрылғыдан шығыңыз.", active: "Белсенді сеанстар", signOutAll: "Барлық құрылғыдан шығу", confirm: "Барлық құрылғыдан, осы құрылғыны қоса, шығасыз ба?", failed: "Сеанстарды аяқтау мүмкін болмады." },
  en: { title: "Sessions", intro: "Sign out on every device if you lost a phone or signed in on someone else's computer.", active: "Active sessions", signOutAll: "Sign out everywhere", confirm: "Sign out on every device, including this one?", failed: "Could not end the sessions." },
} as const;

export function SessionsPanel() {
  const locale = useLocale();
  const copy = SESSIONS_COPY[locale];
  const router = useRouter();
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiRequest<AccountSessionList>("/me/sessions").then(list => { if (active) setCount(list.items.length); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function signOutEverywhere() {
    if (busy || !window.confirm(copy.confirm)) return;
    setBusy(true); setMessage(null);
    try {
      await apiRequest<{ revoked: number }>("/me/sessions/revoke-all", { method: "POST" });
      clearSession();
      router.replace(localeUrl("/login", locale));
    } catch (error) { setMessage(error instanceof Error ? error.message : copy.failed); setBusy(false); }
  }

  return <section className="account-card account-sessions">
    <div><h2>{copy.title}</h2><p className="account-subtitle">{copy.intro}</p></div>
    {count !== null ? <p className="account-muted">{copy.active}: {count}</p> : null}
    <button className="account-button" disabled={busy} type="button" onClick={() => void signOutEverywhere()}>{copy.signOutAll}</button>
    {message ? <p role="status" className="account-message">{message}</p> : null}
  </section>;
}
