"use client";
import type { VerificationView } from "@event-platform/shared-types";
import { AccountIcon } from "../../../components/account-icon";
import { SupportFile, SupportStatus, useSupportText } from "../../../components/platform-support";
import { useLocale } from "../../../components/locale-provider";
import { INTL_LOCALES } from "../../../lib/locale";

export function VerificationHistory({ rows, onOpen, onError }: {
  rows: VerificationView[];
  onOpen: (caseId: string) => void;
  onError: (message: string) => void;
}) {
  const t = useSupportText(), locale = useLocale();
  return <section className="account-card verification-history-card">
    <h2>{t("История заявок", "Өтініштер тарихы", "Submission history")}</h2>
    <div className="verification-history-list">{rows.map(row => <article className="support-verification-history" key={row.id}>
      <header className="verification-history-header">
        <div><p className="verification-history-version">{t("Заявка", "Өтініш", "Application")} №{row.version}</p><h3>{row.legalName}</h3></div>
        <SupportStatus status={row.status} />
      </header>
      <time className="verification-history-date" dateTime={row.createdAt}>{new Intl.DateTimeFormat(INTL_LOCALES[locale], { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.createdAt))}</time>
      {row.reviewReason ? <p className="verification-history-reason">{row.reviewReason}</p> : null}
      {row.documents.length ? <div className="verification-history-documents">{row.documents.map(file => <SupportFile key={file.id} file={file} onError={onError} />)}</div> : null}
      <button type="button" className="account-text-link verification-history-conversation" onClick={() => onOpen(row.caseId)}><AccountIcon name="messages" />{t("Переписка", "Хаттар", "Conversation")}<AccountIcon name="arrow-right" /></button>
    </article>)}</div>
  </section>;
}
