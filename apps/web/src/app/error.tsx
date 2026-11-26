"use client";
import Link from "next/link";
import { useLocale } from "../components/locale-provider";
import { localeUrl } from "../lib/locale";

const COPY = {
  ru: { title: "Что-то пошло не так", text: "Страница не загрузилась. Попробуйте ещё раз — ваши данные не потеряны.", retry: "Попробовать снова", home: "На главную" },
  kk: { title: "Бірдеңе дұрыс болмады", text: "Бет жүктелмеді. Қайталап көріңіз — деректеріңіз сақталған.", retry: "Қайталау", home: "Басты бетке" },
  en: { title: "Something went wrong", text: "The page did not load. Please try again — your data is safe.", retry: "Try again", home: "Go home" },
};

export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const locale = useLocale(), copy = COPY[locale];
  return <main className="tk-status-page">
    <section className="tk-status-card">
      <span className="tk-status-ico is-error" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 8v5m0 3.5v.5"/><circle cx="12" cy="12" r="9"/></svg></span>
      <h1>{copy.title}</h1>
      <p className="tk-status-text">{copy.text}</p>
      <div className="tk-status-actions">
        <button className="tk-btn tk-btn-primary" type="button" onClick={() => reset()}>{copy.retry}</button>
        <Link className="tk-btn tk-btn-ghost" href={localeUrl("/", locale)}>{copy.home}</Link>
      </div>
    </section>
  </main>;
}
