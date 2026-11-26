"use client";
import { useEffect, useState } from "react";
import type { DraftTranslationResult, EventLocale } from "@event-platform/shared-types";
import { creationDraftRequest, DraftRequestError, type DraftAutosave } from "../../lib/creation-draft-client";

const copy = {
  ru: { language: "Язык контента", source: "Исходный язык", translate: "Перевести незаполненные поля", translating: "Переводим…", unavailable: "Автоперевод не настроен. Можно заполнить перевод вручную.", failed: "Не удалось перевести. Ваш текст сохранён; попробуйте снова.", tooLong: "Перевод превышает лимит поля. Сократите исходный текст и попробуйте снова." },
  en: { language: "Content language", source: "Source language", translate: "Translate empty fields", translating: "Translating…", unavailable: "Automatic translation is not configured. You can enter translations manually.", failed: "Translation failed. Your text is preserved; please retry.", tooLong: "The translation exceeds a field limit. Shorten the source text and try again." },
  kk: { language: "Контент тілі", source: "Бастапқы тіл", translate: "Бос өрістерді аудару", translating: "Аударылуда…", unavailable: "Автоматты аударма бапталмаған. Аударманы қолмен енгізуге болады.", failed: "Аудару орындалмады. Мәтініңіз сақталды; қайта көріңіз.", tooLong: "Аударма өріс шегінен асады. Бастапқы мәтінді қысқартып, қайта көріңіз." },
};
const options = {
  ru: { question: "Хотите добавить свой текст на других языках?", automatic: "TICKET автоматически переведёт текст, для которого нет вашего перевода.", toggle: "Свои переводы" },
  en: { question: "Add your own text in other languages?", automatic: "TICKET translates any text you leave untranslated.", toggle: "Custom translations" },
  kk: { question: "Басқа тілдерде өз мәтініңізді қосқыңыз келе ме?", automatic: "Өз аудармаңызды қоспасаңыз, мәтінді TICKET аударады.", toggle: "Өз аудармаларым" },
};
const languageNames = { ru: "RU", en: "ENG", kk: "KAZ" };

export function LocaleActions({ client, locale, contentLocale, onLocale }: { client: DraftAutosave; locale: EventLocale; contentLocale: EventLocale; onLocale: (locale: EventLocale) => void }) {
  const c = copy[locale], source = client.aggregate.sourceLocale, labels = options[locale];
  const [expanded, setExpanded] = useState(() => contentLocale !== source || Object.entries(client.aggregate.metadata).some(([language, fields]) =>
    language !== source && Object.values(fields ?? {}).some(field => field.origin === "manual")
  ));
  const showEditors = expanded || contentLocale !== source;
  const [configured, setConfigured] = useState<boolean | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (!showEditors) return;
    let active = true;
    void creationDraftRequest<{ configured: boolean }>(`/api/creation-drafts/${client.saved.id}/translations`).then(result => { if (active) setConfigured(result.configured); }).catch(() => { if (active) setConfigured(false); });
    return () => { active = false; };
  }, [client, showEditors]);
  useEffect(() => { setError(""); }, [contentLocale]);

  async function translate() {
    if (contentLocale === source || !configured || loading) return;
    setLoading(true); setError("");
    const target = contentLocale;
    try {
      await client.translationMutation(saved => creationDraftRequest<DraftTranslationResult>(`/api/creation-drafts/${saved.id}/translations`, {
        method: "POST", headers: { "content-type": "application/json", "x-draft-csrf": saved.csrfToken },
        body: JSON.stringify({ revision: saved.revision, targetLocale: target, onlyMissing: true }),
      }));
    } catch (reason) {
      setError(reason instanceof DraftRequestError && reason.code === "TRANSLATION_TOO_LONG" ? c.tooLong : c.failed);
    } finally { setLoading(false); }
  }

  return <section className="space-y-3">
    <div className="creation-translation-question">
      <span className="creation-translation-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5Z"/></svg></span>
      <div><strong>{labels.question}</strong><p>{labels.automatic}</p></div>
      <button className="creation-button creation-translation-toggle" type="button" aria-expanded={showEditors} disabled={loading} onClick={() => {
        setExpanded(!showEditors);
        if (showEditors && contentLocale !== source) onLocale(source);
      }}>{labels.toggle}<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
    </div>
    {showEditors ? <div className="creation-translation-body"><div className="creation-locale-row"><span>{c.language}</span><div className="creation-locale-control-row"><div className="creation-locale-switcher"><div role="group" aria-label={c.language} className="creation-locale-tabs">{(["ru", "en", "kk"] as const).map(value => <button key={value} type="button" aria-pressed={value === contentLocale} disabled={loading} onClick={() => onLocale(value)}>{languageNames[value]}</button>)}</div><p className="creation-source-note">{c.source}: {languageNames[source]}</p></div>
      <button type="button" className="creation-translate-button" disabled={contentLocale === source || !configured || loading || /REVISION|EXPIRED|NOT_FOUND/.test(client.error?.message ?? "")} onClick={() => void translate()}>{loading ? c.translating : c.translate}</button>
    </div></div>
    {contentLocale !== source && configured === false ? <p role="status" className="text-sm text-slate-600 dark:text-ticket-muted">{c.unavailable}</p> : null}
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-ticket-danger">{error}</p> : null}
    </div> : null}
  </section>;
}
