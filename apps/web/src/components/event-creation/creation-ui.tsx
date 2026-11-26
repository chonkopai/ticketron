import type { ReactNode } from "react";

export type CreationIconName = "image" | "image-plus" | "upload" | "align-left" | "calendar-days" | "map-pin" | "map" | "ticket1" | "ticket-check" | "ticket2" | "armchair" | "eye" | "arrow-up-right" | "cloud-check" | "lock-keyhole" | "plus" | "circle" | "circle-check";

/** Keep the exported SVG's intrinsic dimensions; sizing belongs to the slot. */
export function CreationIcon({ name, size = 19 }: { name: CreationIconName; size?: number }) {
  return <span aria-hidden="true" className="creation-icon" style={{ width: size, height: size }}>{name === "map" ? <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15" /></svg> : <img src={`/event-creation/${name}.svg`} alt="" />}</span>;
}

const stepWords = { ru: { step: "Шаг", done: "Готово" }, en: { step: "Step", done: "Done" }, kk: { step: "Қадам", done: "Дайын" } };

export function CreationCard({ id, title, icon, aside, children, step, done, locale = "ru" }: { id: string; title: string; icon: CreationIconName; aside?: ReactNode; children: ReactNode; step?: number; done?: boolean | undefined; locale?: "ru" | "en" | "kk" }) {
  return <section id={id} className="creation-card" aria-labelledby={`${id}-heading`} tabIndex={-1}>
    <div className="creation-card-heading"><span className="creation-card-icon"><CreationIcon name={icon} /></span><div className="creation-card-title">{step ? <small>{stepWords[locale].step} {step}</small> : null}<h2 id={`${id}-heading`}>{title}</h2></div><div className="creation-card-aside">{aside}{done ? <span className="creation-done"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>{stepWords[locale].done}</span> : null}</div></div>
    {children}
  </section>;
}
