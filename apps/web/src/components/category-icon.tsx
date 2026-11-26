import type { EventCategory } from "@event-platform/shared-types";
import type { ReactNode } from "react";

/** Category colours and line icons shared by the catalog and the event creation form. */
export const CATEGORY_HUES: Record<EventCategory | "all", string> = {
  all: "#6320ee", music: "#7c3aed", nightlife: "#4f46e5", festival: "#d97706", comedy: "#ea580c", theatre: "#e11d48",
  business: "#475569", education: "#2563eb", workshop: "#0d9488", sport: "#16a34a", family: "#db2777", children: "#0284c7",
  adults: "#dc2626", cinema: "#9333ea", exhibitions: "#a16207", excursions: "#059669", food: "#c2410c", other: "#64748b",
};

export const CATEGORY_ICONS = {
  all: <><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><circle cx="17" cy="17" r="3.5" /></>,
  music: <><path d="M9 18V6.5l10-2.5v11.5" /><path d="M9 10.5l10-2.5" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="15.5" r="2.5" /></>,
  nightlife: <><path d="M4.5 5h15L12 13.5 4.5 5Z" /><path d="M12 13.5V20M8.5 20h7" /><path d="M14.5 9 18 2.5" /></>,
  festival: <><path d="M3 20.5 12 7l9 13.5H3Z" /><path d="M9.5 20.5 12 15.5l2.5 5" /><path d="M12 7V2.5l3.5 1.3L12 5.2" /></>,
  comedy: <><rect x="9" y="2.5" width="6" height="10.5" rx="3" /><path d="M6 10.5a6 6 0 0 0 12 0M12 16.5V21M9 21h6" /></>,
  theatre: <><path d="M2.5 7c3 1.3 6.5 1.3 9.5 0v5.2c0 3.8-2.1 6.8-4.75 6.8S2.5 16 2.5 12.2V7Z" /><path d="M5 10.8h1.2M8.3 10.8h1.2M5.3 14.2c1.1 1.1 2.8 1.1 3.9 0" /><path d="M12 4.6c3 1.3 6.5 1.3 9.5 0v5.2c0 3.8-2.1 6.8-4.75 6.8-1 0-2-.4-2.75-1.2" /><path d="M14.5 8.4h1.2M17.8 8.4h1.2M15 12.4c1.1-1 2.7-1 3.7 0" /></>,
  business: <><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18" /><path d="M11 12.5v2h2v-2" /></>,
  education: <><path d="m2.5 9 9.5-4.5L21.5 9 12 13.5 2.5 9Z" /><path d="M6.5 11v4.8c3.5 2.6 7.5 2.6 11 0V11" /><path d="M21.5 9v5" /></>,
  workshop: <><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 1.6-2.1-.5-1.3.4-2.4 1.8-2.4H18a3 3 0 0 0 3-3C21 7.1 17 3 12 3Z" /><circle cx="7.5" cy="11.5" r="1.2" /><circle cx="10" cy="7.3" r="1.2" /><circle cx="15" cy="7.5" r="1.2" /></>,
  sport: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3v18" /><path d="M5.6 5.6c2.6 2.6 2.6 10.2 0 12.8M18.4 5.6c-2.6 2.6-2.6 10.2 0 12.8" /></>,
  family: <><path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19v-8.5Z" /><path d="M12 17s-3.2-2-3.2-4.1a1.7 1.7 0 0 1 3.2-.8 1.7 1.7 0 0 1 3.2.8C15.2 15 12 17 12 17Z" /></>,
  children: <><path d="M12 15c3.3 0 6-3 6-6.5S15.3 2.5 12 2.5 6 5 6 8.5 8.7 15 12 15Z" /><path d="m11 15-.6 1.4h3.2L13 15" /><path d="M12 16.4c0 2-2 2.6-1 5.1" /><path d="M9.5 7a2.8 2.8 0 0 1 2-2" /></>,
  adults: <><rect x="2.5" y="5" width="19" height="14" rx="4" /><path d="M6.5 10 8 9v6" /><circle cx="12" cy="10.4" r="1.4" /><circle cx="12" cy="13.6" r="1.6" /><path d="M15.8 12h3.4M17.5 10.3v3.4" /></>,
  cinema: <><path d="M4 9.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V9.5Z" /><path d="m4 9.5-.6-2.3a1.5 1.5 0 0 1 1.1-1.8l12.6-3.2a1.5 1.5 0 0 1 1.8 1.1l.6 2.3L4 9.5Z" /><path d="m8.2 4.4 2.3 3.6M13 3.2l2.3 3.6" /></>,
  exhibitions: <><path d="M3 9 12 4l9 5" /><path d="M4 9h16M5.5 9v8M10 9v8M14 9v8M18.5 9v8M3.5 17h17M2.5 20.5h19" /></>,
  excursions: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" /></>,
  food: <><path d="M5 3v5a2 2 0 0 0 4 0V3M7 3v18" /><path d="M17 21V3c-2.2 1.2-3.5 4-3.5 7.5V13H17" /></>,
  other: <><path d="M11 3.5 12.6 8l4.4 1.6-4.4 1.6L11 15.6l-1.6-4.4L5 9.6 9.4 8 11 3.5Z" /><path d="m18 14.5.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" /></>,
} satisfies Record<EventCategory | "all", ReactNode>;

export function CategoryIcon({ category }: { category: EventCategory | "all" }) {
  return <svg aria-hidden="true" className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {CATEGORY_ICONS[category]}
  </svg>;
}
