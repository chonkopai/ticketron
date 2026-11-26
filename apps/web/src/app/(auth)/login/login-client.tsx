"use client";

import { type AuthResponse, type EventLocale, type LoginContactMethod, type VerificationGrantResponse, type VerificationRequestResponse } from "@event-platform/shared-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { GoogleLoginButton } from "../_components/google-login-button";
import { TelegramLoginButton } from "../_components/telegram-login-button";
import { publicAuthRequest, safeReturnPath } from "../_lib/public-auth";
import { saveSession } from "../_lib/session";
import { beginTelegramLogin, cancelTelegramLogin } from "../_lib/telegram-oidc";
import { TELEGRAM_AUTH_COPY } from "../_lib/telegram-auth-copy";
import { useLocale } from "../../../components/locale-provider";
import { OptionPicker } from "../../../components/option-picker";
import { ThemeToggle } from "../../../components/theme-toggle";
import { localeUrl } from "../../../lib/locale";
import { AUTH_COPY } from "./auth-copy";

type Mode = "login" | "register" | "reset";
type Step = "contact" | "code" | "details";

const LANGUAGE_OPTIONS = [
  { value: "ru", label: "Русский", compactLabel: "RU" },
  { value: "kk", label: "Қазақша", compactLabel: "KZ" },
  { value: "en", label: "English", compactLabel: "EN" },
];

export function LoginClient() {
  const locale = useLocale();
  const copy = AUTH_COPY[locale];
  const telegramCopy = TELEGRAM_AUTH_COPY[locale];
  const router = useRouter();
  const sequence = useRef(0);
  const [method, setMethod] = useState<LoginContactMethod>("email");
  const [mode, setMode] = useState<Mode>("login");
  const [step, setStep] = useState<Step>("contact");
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [grant, setGrant] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegramPhone, setTelegramPhone] = useState(false);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const telegramSequence = useRef(0);
  const [navigationQuery, setNavigationQuery] = useState("");

  useEffect(() => {
    setNavigationQuery(window.location.search.slice(1));
    if (new URLSearchParams(window.location.search).get("telegram") === "phone") { setTelegramOpen(true); setTelegramPhone(true); }
    cancelTelegramLogin();
    const resume = (event: PageTransitionEvent) => {
      // Initial pageshow can follow a click while images/fonts are still loading.
      // Only a return from the browser's back/forward cache abandons the old request.
      if (!event.persisted) return;
      telegramSequence.current++; cancelTelegramLogin(); setTelegramBusy(false);
    };
    window.addEventListener("pageshow", resume);
    return () => { telegramSequence.current++; window.removeEventListener("pageshow", resume); };
  }, []);

  function closeTelegram() {
    telegramSequence.current++; cancelTelegramLogin(); setTelegramBusy(false); setTelegramOpen(false);
  }

  function useTelegramPhone() {
    telegramSequence.current++; cancelTelegramLogin(); setTelegramBusy(false); setTelegramError(null); setTelegramOpen(true); setTelegramPhone(true);
  }

  async function startTelegram() {
    if (telegramBusy) return;
    const ticket = ++telegramSequence.current;
    setTelegramOpen(true); setTelegramPhone(false); setTelegramBusy(true); setTelegramError(null);
    try {
      const url = await beginTelegramLogin(locale, safeReturnPath());
      if (ticket !== telegramSequence.current) return;
      if (url) window.location.assign(url);
      else setTelegramBusy(false);
    } catch (error) {
      if (ticket === telegramSequence.current) { setTelegramError(errorMessage(error, telegramCopy.unavailable)); setTelegramPhone(true); setTelegramBusy(false); }
    }
  }

  useEffect(() => {
    if (!retryAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  function resetFlow(nextMethod = method, nextMode = mode) {
    sequence.current++;
    if (nextMethod !== method) setTarget("");
    setMethod(nextMethod);
    setMode(nextMode);
    setStep("contact");
    setCode("");
    setChallengeId("");
    setGrant("");
    setPassword("");
    setShowPassword(false);
    setMessage(null);
    setBusy(false);
    setRetryAt(0);
    setSecondsLeft(0);
  }

  function updateTarget(value: string) {
    sequence.current++;
    setTarget(value);
    setStep("contact");
    setCode("");
    setChallengeId("");
    setGrant("");
    setRetryAt(0);
    setSecondsLeft(0);
    setBusy(false);
    setMessage(null);
  }

  async function requestCode(resend = false): Promise<void> {
    // Phone registration stays unavailable; reset requests can report unregistered contacts.
    if ((method === "phone" && mode === "register") || mode === "login" || busy) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setMessage(null);
    try {
      const path = mode === "register" ? "/auth/register/request-code" : "/auth/password/reset/request-code";
      const response = await publicAuthRequest<VerificationRequestResponse>(path, { method, target });
      if (ticket !== sequence.current) return;
      setChallengeId(response.challengeId);
      setCode("");
      setStep("code");
      setRetryAt(Date.now() + response.retryAfterSeconds * 1000);
      setMessage(resend ? copy.sentAgain : copy.sent);
    } catch (error) {
      if (ticket === sequence.current) setMessage(errorMessage(error, copy.requestFailed));
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || (method === "phone" && mode === "register")) return;
    if (mode !== "login" && step === "contact") {
      await requestCode();
      return;
    }

    const ticket = ++sequence.current;
    setBusy(true);
    setMessage(null);
    try {
      if (mode === "login") {
        const response = await publicAuthRequest<AuthResponse>("/auth/password/login", { method, target, password });
        if (ticket !== sequence.current) return;
        saveSession(response);
        router.replace(safeReturnPath());
      } else if (step === "code") {
        const path = mode === "register" ? "/auth/register/verify-code" : "/auth/password/reset/verify-code";
        const response = await publicAuthRequest<VerificationGrantResponse>(path, { method, target, challengeId, code });
        if (ticket !== sequence.current) return;
        setGrant(response.grant);
        setStep("details");
        setMessage(copy.verified);
      } else if (mode === "register") {
        const response = await publicAuthRequest<AuthResponse>("/auth/register/complete", { method, target, grant, firstName, lastName, password });
        if (ticket !== sequence.current) return;
        saveSession(response);
        router.replace(safeReturnPath());
      } else {
        await publicAuthRequest<{ reset: true }>("/auth/password/reset/complete", { method, target, grant, newPassword: password });
        if (ticket !== sequence.current) return;
        resetFlow(method, "login");
        setMessage(copy.resetDone);
      }
    } catch (error) {
      if (ticket === sequence.current) setMessage(errorMessage(error, copy.requestFailed));
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  }

  function switchLocale(value: string): void {
    if (value !== "ru" && value !== "kk" && value !== "en") return;
    window.location.assign(localeUrl(`${window.location.pathname}${window.location.search}${window.location.hash}`, value as EventLocale));
  }

  const catalogHref = navigationQuery ? "/?" + navigationQuery : "/";
  const title = mode === "register" ? copy.registerTitle : mode === "reset" ? copy.resetTitle : copy.loginTitle;
  const subtitle = step === "code" ? copy.codeSubtitle
    : step === "details" ? (mode === "register" ? copy.registerDetailsSubtitle : copy.resetDetailsSubtitle)
    : mode === "register" ? copy.registerSubtitle : mode === "reset" ? copy.resetSubtitle : copy.loginSubtitle;
  const smsUnavailable = method === "phone" && mode === "register";
  const contactLabel = method === "email" ? copy.emailAddress : copy.phoneNumber;
  const showSocial = telegramOpen || (mode !== "reset" && step === "contact");

  return (
    <main className="ticket-auth ticket-login relative isolate flex min-h-svh flex-col text-ticket-text">
      <LoginBackdrop />

      <header className="relative z-20 mx-auto flex w-full max-w-[1200px] items-center justify-between gap-3 px-4 py-3.5 sm:px-6 sm:py-[18px]">
        <Link className="ticket-auth-wordmark inline-flex items-center gap-1.5 rounded-md text-xl font-extrabold tracking-[-0.04em] text-ticket-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent" href={catalogHref} aria-label={copy.catalog}>
          <TicketIcon className="h-6 w-6 shrink-0" /><span>TICKET</span>
        </Link>
        <div className="flex items-center gap-2">
          <div className="ticket-login-pill">
            <Link className="ticket-login-pill-item" href={catalogHref} aria-label={copy.backToCatalog}>
              <ArrowLeftIcon /><span className="hidden sm:inline">{copy.backToCatalog}</span>
            </Link>
          </div>
          <div className="ticket-login-pill">
            <OptionPicker appearance="bare" icon={<GlobeIcon />} label={copy.language} value={locale} options={LANGUAGE_OPTIONS} onChange={switchLocale} />
            <span className="ticket-login-pill-separator" aria-hidden="true" />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="relative z-10 grid flex-1 place-items-center px-4 pb-10 pt-4">
        <section className="w-full max-w-[420px] rounded-[24px] border border-ticket-border bg-ticket-surface px-5 pb-6 pt-8 shadow-[0_1px_2px_rgb(21_28_39/.04),0_12px_40px_-12px_rgb(60_30_120/.14)] transition-colors dark:shadow-[0_1px_2px_rgb(0_0_0/.3),0_20px_50px_-16px_rgb(0_0_0/.6)] sm:rounded-[28px] sm:px-9 sm:pb-8 sm:pt-10" aria-label={copy.authRegion}>
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-b from-[#7a3cff] to-[#5316d6] text-white shadow-[0_8px_20px_-6px_rgb(99_32_238/.5),inset_0_1px_0_rgb(255_255_255/.25)]" aria-hidden="true">
            <TicketIcon className="h-7 w-7" />
          </div>
          <h1 className="text-center text-[28px] font-bold leading-[1.15] tracking-[-0.03em]">{telegramOpen ? copy.telegramTitle : title}</h1>
          <p className="mx-auto mb-7 mt-2 max-w-[300px] text-center text-[15px] leading-[1.45] text-ticket-muted">{telegramOpen ? (telegramPhone ? telegramCopy.phoneHint : telegramCopy.hint) : subtitle}</p>

          {!telegramOpen && mode !== "reset" ? (
            <div className="ticket-login-segmented" data-active={mode} role="group" aria-label={copy.actionLabel}>
              <span className="ticket-login-segmented-thumb" aria-hidden="true" />
              {(["login", "register"] as const).map((item) => (
                <button aria-pressed={mode === item} key={item} onClick={() => resetFlow(method, item)} type="button">
                  {item === "login" ? copy.login : copy.register}
                </button>
              ))}
            </div>
          ) : null}

          {showSocial ? (
            <>
              <div className="grid gap-2.5" aria-label={copy.methods} role="group">
                {/* Stays mounted while Telegram opens so its disabled state blocks duplicate attempts and doubles as "retry". */}
                <button
                  aria-busy={telegramBusy}
                  aria-controls={telegramOpen ? "telegram-login-panel" : undefined}
                  aria-expanded={telegramOpen}
                  aria-label={telegramCopy.continue}
                  className="flex h-[50px] w-full items-center justify-center gap-2.5 rounded-full bg-ticket-text text-[15px] font-medium text-ticket-surface transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent focus-visible:ring-offset-2 active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
                  disabled={telegramBusy}
                  onClick={() => void startTelegram()}
                  type="button"
                >
                  {telegramBusy ? <SpinnerIcon /> : <TelegramIcon />}{telegramCopy.continue}
                </button>
                {!telegramOpen ? (
                  <>
                    <div className="grid grid-cols-2 gap-2.5">
                      {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? <GoogleLoginButton variant="pill" /> : <ProviderButton provider="google" />}
                      <ProviderButton provider="apple" />
                    </div>
                    <button className="mx-auto min-h-9 rounded-full px-3 text-[13px] font-medium text-ticket-muted transition hover:text-ticket-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent" type="button" onClick={useTelegramPhone}>{telegramCopy.phone}</button>
                  </>
                ) : null}
              </div>
              {!telegramOpen ? <div className="my-4 flex items-center gap-3.5 text-[13px] text-ticket-dim before:h-px before:flex-1 before:bg-ticket-border after:h-px after:flex-1 after:bg-ticket-border" aria-hidden="true">{copy.or}</div> : null}
            </>
          ) : null}

          {telegramOpen ? (
            <div className="mt-3 grid gap-3" id="telegram-login-panel">
              {telegramBusy ? <p className="text-center text-sm text-ticket-muted" role="status">{telegramCopy.waiting}</p> : null}
              {telegramError ? <p className="rounded-[14px] bg-ticket-danger-soft px-4 py-3 text-sm leading-5 text-ticket-danger" role="alert">{telegramError}</p> : null}
              {telegramPhone ? <div className="flex justify-center"><TelegramLoginButton /></div> : <button className={secondaryClass} onClick={useTelegramPhone} type="button">{telegramCopy.phone}</button>}
              <div className="mt-1 flex justify-center">
                <button className={backClass} onClick={closeTelegram} type="button" aria-label={copy.telegramClose}><ChevronLeftIcon />{copy.telegramReturn}</button>
              </div>
            </div>
          ) : smsUnavailable ? (
            <div className="grid gap-3.5">
              <ContactField method={method} label={contactLabel} target={target} onChange={updateTarget} onToggleMethod={() => resetFlow("email", mode)} />
              <div className="rounded-[14px] bg-ticket-raised px-4 py-3 text-sm leading-5 text-ticket-muted" role="note">{copy.smsUnavailable}</div>
              <button className={submitClass} disabled type="button">{copy.smsSoon}</button>
            </div>
          ) : (
            <form className="grid gap-3.5" onSubmit={submit}>
              {step === "contact" || mode === "login" ? (
                <ContactField method={method} label={contactLabel} target={target} onChange={updateTarget} onToggleMethod={() => resetFlow(method === "email" ? "phone" : "email", mode)} />
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-[14px] bg-ticket-accent-soft px-3.5 py-3 text-sm">
                  <span className="min-w-0 text-[13px] leading-5 text-ticket-muted">{step === "details" ? copy.verifiedAddress : copy.codeSentTo}<strong className="block text-sm font-semibold text-ticket-text [overflow-wrap:anywhere]">{maskDestination(target, method)}</strong></span>
                  <button className={linkClass} onClick={() => resetFlow(method, mode)} type="button">{copy.change}</button>
                </div>
              )}

              {mode !== "login" && step === "code" ? (
                <div className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <label className={labelClass} htmlFor="verification-code">{copy.mailCode}</label>
                    <button className={linkClass} disabled={busy || secondsLeft > 0} onClick={() => void requestCode(true)} type="button">
                      {secondsLeft > 0 ? `${copy.resendIn} ${secondsLeft} ${locale === "en" ? "s" : "с"}` : copy.resend}
                    </button>
                  </div>
                  <input autoComplete="one-time-code" className={fieldClass + " h-14 pl-[calc(1rem+0.5em)] text-center text-2xl font-semibold tabular-nums tracking-[0.5em]"} id="verification-code" inputMode="numeric" maxLength={6} onChange={(event) => { setCode(event.target.value.replace(/\D/g, "")); setMessage(null); }} pattern="[0-9]{6}" placeholder="••••••" required type="text" value={code} />
                </div>
              ) : null}

              {mode === "register" && step === "details" ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <TextField id="first-name" label={copy.firstName} autoComplete="given-name" maxLength={100} value={firstName} onChange={setFirstName} disabled={busy} />
                  <TextField id="last-name" label={copy.lastName} autoComplete="family-name" maxLength={100} value={lastName} onChange={setLastName} disabled={busy} />
                </div>
              ) : null}

              {mode === "login" || step === "details" ? (
                <PasswordField mode={mode} password={password} showPassword={showPassword} busy={busy} onForgot={() => resetFlow(method, "reset")} onChange={(value) => { setPassword(value); setMessage(null); }} onToggle={() => setShowPassword((value) => !value)} />
              ) : null}

              <button className={submitClass} disabled={busy || (mode === "register" && step === "contact" && method === "phone")} type="submit">
                {busy ? <><SpinnerIcon /><span className="sr-only">{copy.wait}</span></> : <span>{submitLabel(mode, step, copy)}</span>}
              </button>
            </form>
          )}

          {message ? <p aria-live="polite" className="mt-4 rounded-[14px] bg-ticket-accent-soft px-3.5 py-3 text-sm leading-5 text-ticket-text" role="status">{message}</p> : null}

          {mode === "reset" && !telegramOpen ? (
            <div className="mt-5 flex justify-center">
              <button className={backClass} type="button" onClick={() => resetFlow(method, "login")}><ChevronLeftIcon />{copy.backToLogin}</button>
            </div>
          ) : null}

          <p className="mx-auto mt-6 max-w-[320px] text-center text-xs leading-normal text-ticket-dim">{copy.legal}</p>
        </section>
      </div>
    </main>
  );
}

/* Slow, decorative concert/ticket atmosphere behind the card. Purely visual; disabled under reduced motion. */
const FLOATERS: { left: number; size: number; duration: number; delay: number; rotate: number; spin: number; sway: number; alpha: number; kind: "ticket" | "star" }[] = [
  { left: 6, size: 64, duration: 58, delay: -4, rotate: -18, spin: 40, sway: 60, alpha: .16, kind: "ticket" },
  { left: 18, size: 28, duration: 46, delay: -30, rotate: 0, spin: 120, sway: -40, alpha: .22, kind: "star" },
  { left: 27, size: 44, duration: 64, delay: -18, rotate: 12, spin: -30, sway: 80, alpha: .12, kind: "ticket" },
  { left: 42, size: 22, duration: 52, delay: -44, rotate: 0, spin: 90, sway: 30, alpha: .2, kind: "star" },
  { left: 58, size: 52, duration: 70, delay: -8, rotate: -8, spin: 25, sway: -70, alpha: .12, kind: "ticket" },
  { left: 71, size: 30, duration: 48, delay: -22, rotate: 0, spin: -100, sway: 50, alpha: .2, kind: "star" },
  { left: 80, size: 72, duration: 62, delay: -36, rotate: 20, spin: -45, sway: -50, alpha: .14, kind: "ticket" },
  { left: 92, size: 36, duration: 54, delay: -12, rotate: -24, spin: 35, sway: -30, alpha: .14, kind: "ticket" },
  { left: 12, size: 34, duration: 66, delay: -50, rotate: 30, spin: -20, sway: 40, alpha: .1, kind: "ticket" },
  { left: 64, size: 18, duration: 40, delay: -2, rotate: 0, spin: 160, sway: 20, alpha: .22, kind: "star" },
];

function LoginBackdrop() {
  return (
    <div className="ticket-login-backdrop" aria-hidden="true">
      <div className="ticket-login-beam ticket-login-beam-left" />
      <div className="ticket-login-beam ticket-login-beam-right" />
      <div className="ticket-login-orb ticket-login-orb-1" />
      <div className="ticket-login-orb ticket-login-orb-2" />
      <div className="ticket-login-orb ticket-login-orb-3" />
      {FLOATERS.map((item, index) => (
        <div className="ticket-login-floater" key={index} style={{
          left: `${item.left}%`, width: item.size,
          "--float-duration": `${item.duration}s`, "--float-delay": `${item.delay}s`, "--float-rotate": `${item.rotate}deg`,
          "--float-spin": `${item.spin}deg`, "--float-sway": `${item.sway}px`, "--float-alpha": item.alpha,
        } as CSSProperties}>
          {item.kind === "ticket" ? <TicketIcon className="h-auto w-full" strokeWidth={1.2} /> : <SparkleIcon />}
        </div>
      ))}
      <div className="ticket-login-grain" />
    </div>
  );
}

function ProviderButton({ provider }: { provider: "google" | "apple" }) {
  const copy = AUTH_COPY[useLocale()];
  const label = provider === "google" ? "Google" : "Apple";
  return (
    <button aria-disabled="true" aria-label={label + ", " + copy.soon} className="flex h-[50px] min-w-0 cursor-default items-center justify-center gap-2 rounded-full border border-ticket-border bg-ticket-surface px-2 text-[15px] font-medium text-ticket-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent" title={label + ": " + copy.soon} type="button">
      <span className="opacity-60">{provider === "google" ? <GoogleIcon /> : <AppleIcon />}</span>
      <span className="truncate">{label}</span>
      <span className="shrink-0 rounded-full bg-ticket-raised px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.02em]">{copy.soon}</span>
    </button>
  );
}

function ContactField({ method, label, target, onChange, onToggleMethod }: { method: LoginContactMethod; label: string; target: string; onChange: (value: string) => void; onToggleMethod: () => void }) {
  const copy = AUTH_COPY[useLocale()];
  const id = method === "email" ? "auth-email" : "auth-phone";
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className={labelClass} htmlFor={id}>{label}</label>
        <button className={linkClass} onClick={onToggleMethod} type="button">{method === "email" ? copy.usePhone : copy.useEmail}</button>
      </div>
      <input autoComplete={method === "email" ? "email" : "tel"} className={fieldClass} id={id} onChange={(event) => onChange(event.target.value)} placeholder={method === "phone" ? "+7 (7__) ___-__-__" : "name@example.com"} required type={method === "email" ? "email" : "tel"} value={target} />
    </div>
  );
}

function PasswordField({ mode, password, showPassword, busy, onChange, onToggle, onForgot }: {
  mode: Mode; password: string; showPassword: boolean; busy: boolean; onChange: (value: string) => void; onToggle: () => void; onForgot: () => void;
}) {
  const copy = AUTH_COPY[useLocale()];
  const label = mode === "reset" ? copy.newPassword : copy.password;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className={labelClass} htmlFor="auth-password">{label}</label>
        {mode === "login" ? <button className={linkClass} onClick={onForgot} type="button">{copy.forgot}</button> : null}
      </div>
      <span className="relative block">
        <input autoComplete={mode === "login" ? "current-password" : "new-password"} className={fieldClass + " pr-12"} disabled={busy} id="auth-password" maxLength={1024} minLength={mode === "login" ? undefined : 12} onChange={(event) => onChange(event.target.value)} placeholder={mode === "login" ? copy.passwordPlaceholder : copy.newPasswordPlaceholder} required type={showPassword ? "text" : "password"} value={password} />
        <button aria-label={showPassword ? copy.hidePassword : copy.showPassword} aria-pressed={showPassword} className="absolute right-1.5 top-1/2 grid h-[38px] w-[38px] -translate-y-1/2 place-items-center rounded-[10px] text-ticket-dim transition hover:text-ticket-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent" onClick={onToggle} type="button">
          {showPassword ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </span>
      {mode !== "login" ? <span className="text-xs text-ticket-dim">{copy.passwordMinimum}</span> : null}
    </div>
  );
}

function TextField({ id, label, autoComplete, maxLength, value, onChange, disabled }: {
  id: string; label: string; autoComplete: string; maxLength: number; value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  return <div className="grid min-w-0 gap-1.5">
    <label className={labelClass} htmlFor={id}>{label}</label>
    <input autoComplete={autoComplete} className={fieldClass} disabled={disabled} id={id} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} required type="text" value={value} />
  </div>;
}

const labelClass = "text-[13px] font-medium text-ticket-muted";
const linkClass = "shrink-0 rounded text-[13px] font-medium text-ticket-accent underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent disabled:cursor-default disabled:text-ticket-dim disabled:no-underline";
const fieldClass = "h-[50px] w-full min-w-0 rounded-[14px] border border-transparent bg-ticket-raised px-4 text-base text-ticket-text outline-none transition placeholder:text-ticket-dim placeholder:opacity-80 hover:bg-ticket-hover focus:border-ticket-accent focus:bg-ticket-surface focus:ring-4 focus:ring-ticket-accent/15 disabled:opacity-60";
const submitClass = "mt-1.5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-ticket-primary px-5 text-base font-semibold tracking-[-0.01em] text-white transition hover:bg-ticket-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent focus-visible:ring-offset-2 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-45";
const secondaryClass = "flex h-[50px] w-full items-center justify-center rounded-full border border-ticket-border bg-ticket-surface px-4 text-[15px] font-medium transition hover:bg-ticket-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent";
const backClass = "inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-sm font-medium text-ticket-accent transition hover:bg-ticket-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ticket-accent";

function submitLabel(mode: Mode, step: Step, copy: typeof AUTH_COPY.ru) {
  if (mode === "login") return copy.submitLogin;
  if (step === "contact") return mode === "reset" ? copy.submitResetCode : copy.submitCode;
  if (step === "code") return copy.submitConfirm;
  return mode === "register" ? copy.submitRegister : copy.submitPassword;
}
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function maskDestination(target: string, method: LoginContactMethod) {
  if (method === "email") {
    const [local, domain] = target.split("@");
    return domain ? (local ?? "").slice(0, 1) + "***@" + domain : target;
  }
  return target.slice(0, 3) + "***" + target.slice(-4);
}

// Same ticket glyph as the site navbar (components/account-icon.tsx).
function TicketIcon({ className = "", strokeWidth = 1.8 }: { className?: string; strokeWidth?: number }) {
  return <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v3c-1.7 0-3 1.3-3 3s1.3 3 3 3v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3c1.7 0 3-1.3 3-3s-1.3-3-3-3V6a1 1 0 0 1 1-1Z" /><path d="M13 5v2m0 4v2m0 4v2" /></svg>;
}
function SparkleIcon() {
  return <svg aria-hidden="true" className="h-auto w-full" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8Z" /></svg>;
}
function GoogleIcon() {
  return <svg aria-hidden="true" className="h-5 w-5 shrink-0" viewBox="0 0 24 24"><path d="M23.5 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.68v3.05h3.88c2.27-2.09 3.42-5.17 3.42-9.17Z" fill="#4285F4"/><path d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.36 24 12 24Z" fill="#34A853"/><path d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.15Z" fill="#FBBC05"/><path d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.36 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98Z" fill="#EA4335"/></svg>;
}
function AppleIcon() {
  return <svg aria-hidden="true" className="h-5 w-5 shrink-0" viewBox="0 0 24 24"><path d="M16.67 12.93c.02 2.2 1.93 2.93 1.95 2.94-.02.05-.3 1.04-.98 2.07-.59.88-1.2 1.76-2.17 1.78-.95.02-1.26-.57-2.35-.57s-1.43.55-2.33.59c-.93.03-1.64-.96-2.24-1.83-1.22-1.77-2.15-5-.9-7.18.62-1.08 1.73-1.77 2.93-1.79.91-.02 1.76.61 2.32.61.55 0 1.59-.76 2.68-.65.46.02 1.76.18 2.59 1.4-.07.04-1.55.9-1.53 2.63ZM15.02 6.8c.49-.59.82-1.41.73-2.23-.71.03-1.57.47-2.08 1.06-.46.53-.86 1.37-.75 2.18.79.06 1.61-.4 2.1-1.01Z" fill="currentColor"/></svg>;
}
function TelegramIcon() {
  return <svg aria-hidden="true" className="h-5 w-5 shrink-0" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#2aabee" /><path fill="#fff" d="M5.4 11.8 17 7.3c.54-.2 1 .13.83.94l-1.98 9.33c-.15.66-.54.82-1.1.51l-3-2.22-1.46 1.4c-.16.16-.3.3-.6.3l.21-3.05 5.56-5.02c.24-.21-.05-.33-.38-.12L8.2 13.7l-2.96-.92c-.64-.2-.66-.64.14-.97Z" /></svg>;
}
function GlobeIcon() {
  return <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
}
function ArrowLeftIcon() {
  return <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 12H4m6-6-6 6 6 6" /></svg>;
}
function ChevronLeftIcon() {
  return <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>;
}
function EyeIcon() {
  return <svg aria-hidden="true" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function EyeOffIcon() {
  return <svg aria-hidden="true" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.9 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>;
}
function SpinnerIcon() {
  return <svg aria-hidden="true" className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3"/><path className="opacity-75" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeLinecap="round" strokeWidth="3"/></svg>;
}
