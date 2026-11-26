"use client";
import { useLocale } from "./locale-provider";
export function VerifiedOrganizerBadge({
  verified,
  compact = false,
}: {
  verified: boolean | undefined;
  compact?: boolean;
}) {
  const locale = useLocale();
  if (!verified) return null;
  const label = {
    ru: "Проверенный организатор: предоставленные данные рассмотрены командой TICKET",
    kk: "Ұйымдастырушы расталған: деректерді TICKET тобы тексерген",
    en: "Verified organizer: submitted details reviewed by TICKET",
  }[locale];
  if (compact) return <span className="organizer-verified-mark" role="img" aria-label={label} title={label}>
    <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17"><path fill="currentColor" d="m10 1 2.8 2 3.4.3.8 3.3 2 2.9-1.8 2.8-.7 3.5-3.5.5-3 2.7-3-2.7-3.5-.5-.7-3.5L1 9.4l2-2.9.8-3.2L7.2 3Z"/><path fill="none" stroke="var(--organizer-verified-check, white)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="m6.3 10 2.4 2.4 4.9-4.9"/></svg>
  </span>;
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className="ml-1 inline-flex max-w-full align-middle items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200"
    >
      <span aria-hidden="true">✓</span>
      <span>{({ru:"Проверенный организатор",kk:"Расталған ұйымдастырушы",en:"Verified organizer"})[locale]}</span>
    </span>
  );
}
