"use client";

import { useEffect, useState } from "react";
import { useLocale } from "../../../components/locale-provider";

const CHROME_COPY = {
  ru: { sections: "Разделы события", expand: "Открыть схему на весь экран", close: "Закрыть полноэкранную схему", hall: "Схема зала" },
  kk: { sections: "Іс-шара бөлімдері", expand: "Сызбаны толық экранда ашу", close: "Толық экранды сызбаны жабу", hall: "Зал сызбасы" },
  en: { sections: "Event sections", expand: "Open the map full screen", close: "Close the full-screen map", hall: "Venue map" },
} as const;

/** Frosted capsule under the top bar; highlights the section in view. */
export function EventSectionNav({ sections }: { sections: Array<{ id: string; label: string }> }) {
  const copy = CHROME_COPY[useLocale()];
  const [active, setActive] = useState(sections[0]?.id);
  useEffect(() => {
    const sync = () => {
      let current = sections[0]?.id;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top < 180) current = section.id;
      }
      setActive(current);
    };
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, [sections]);
  if (sections.length < 2) return null;
  return <nav className="tke-secnav" aria-label={copy.sections}>
    <div className="tke-secnav-row">{sections.map(section => <a key={section.id} href={`#${section.id}`} className={active === section.id ? "tke-on" : undefined} aria-current={active === section.id ? "true" : undefined}>{section.label}</a>)}</div>
  </nav>;
}

/** Small floating total bar: shown once both the hero button and the ticket panel are out of view. */
export function EventBuyBar({ label, price, action }: { label: string; price: string | null; action: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const sync = () => {
      const inView = (id: string) => { const rect = document.getElementById(id)?.getBoundingClientRect(); return Boolean(rect && rect.bottom > 64 && rect.top < window.innerHeight - 60); };
      setVisible(!inView("hero-cta") && !inView("tickets"));
    };
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => { window.removeEventListener("scroll", sync); window.removeEventListener("resize", sync); };
  }, []);
  return <div className={`tke-buybar${visible ? "" : " tke-hide"}`} aria-hidden={!visible}>
    <div>{price ? <><span>{label}</span><b>{price}</b></> : null}</div>
    <a className="tke-btn" href="#tickets" tabIndex={visible ? 0 : -1}>{action}</a>
  </div>;
}
