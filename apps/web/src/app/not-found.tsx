"use client";
import Link from "next/link";
import { useLocale } from "../components/locale-provider";
import { localeUrl } from "../lib/locale";

const COPY = {
  ru: { title: "Страница не найдена", text: "Возможно, ссылка устарела или мероприятие было снято с публикации.", home: "На главную", events: "Смотреть афишу" },
  kk: { title: "Бет табылмады", text: "Сілтеме ескірген немесе іс-шара жариялаудан алынған болуы мүмкін.", home: "Басты бетке", events: "Афишаны көру" },
  en: { title: "Page not found", text: "The link may be out of date, or the event is no longer published.", home: "Go home", events: "Browse events" },
};

export default function NotFound() {
  const locale = useLocale(), copy = COPY[locale];
  return <main className="tk-status-page">
    <section className="tk-status-card">
      <p className="tk-status-code" aria-hidden="true">404</p>
      <h1>{copy.title}</h1>
      <p className="tk-status-text">{copy.text}</p>
      <div className="tk-status-actions">
        <Link className="tk-btn tk-btn-primary" href={localeUrl("/", locale)}>{copy.events}</Link>
      </div>
    </section>
  </main>;
}
