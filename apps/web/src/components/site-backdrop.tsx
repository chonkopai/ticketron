"use client";

import { usePathname } from "next/navigation";
import { usesStandaloneHeader } from "../lib/theme";

const TICKET = "M4 5h16a1 1 0 0 1 1 1v3c-1.7 0-3 1.3-3 3s1.3 3 3 3v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3c1.7 0 3-1.3 3-3s-1.3-3-3-3V6a1 1 0 0 1 1-1Z M13 5v2m0 4v2m0 4v2";
const STAR = "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8Z";
// [left %, size px, duration s, delay s, rotate, spin, sway px, opacity, star] — mostly along the two side edges
const FLOATERS: Array<[number, number, number, number, number, number, number, number, boolean]> = [
  [1, 48, 46, -4, -16, 30, 40, .2, false], [5, 22, 38, -20, 0, 110, 30, .26, true], [9, 34, 52, -34, 12, -30, 50, .16, false],
  [3, 18, 34, -12, 0, -120, 20, .26, true], [96, 52, 48, -26, 18, -40, -40, .2, false], [92, 22, 36, -6, 0, -90, -20, .26, true],
  [88, 36, 56, -14, -20, 25, -40, .15, false], [98, 18, 40, -32, 0, 140, -20, .26, true], [30, 22, 44, -16, -10, 30, 30, .1, false], [68, 16, 40, -36, 0, 120, -20, .14, true],
];
const HIDDEN = ["/admin"];

/** Slow, barely visible glows and floating ticket outlines behind every public page (login has its own). */
export function SiteBackdrop() {
  const pathname = usePathname() ?? "/";
  if (usesStandaloneHeader(pathname) || HIDDEN.some(prefix => pathname.startsWith(prefix))) return null;
  return <div className="ticket-site-backdrop" aria-hidden="true">
    <div className="ticket-site-beam ticket-site-beam-l" /><div className="ticket-site-beam ticket-site-beam-r" />
    <div className="ticket-site-orb ticket-site-orb-1" /><div className="ticket-site-orb ticket-site-orb-2" /><div className="ticket-site-orb ticket-site-orb-3" /><div className="ticket-site-orb ticket-site-orb-4" />
    {FLOATERS.map(([left, size, duration, delay, rotate, spin, sway, alpha, star], index) => <div className="ticket-site-floater" key={index}
      style={{ left: `${left}%`, width: size, "--dur": `${duration}s`, "--delay": `${delay}s`, "--rot": `${rotate}deg`, "--spin": `${spin}deg`, "--sway": `${sway}px`, "--alpha": alpha } as React.CSSProperties}>
      <svg viewBox="0 0 24 24" fill={star ? "currentColor" : "none"} stroke={star ? "none" : "currentColor"} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d={star ? STAR : TICKET} /></svg>
    </div>)}
  </div>;
}
