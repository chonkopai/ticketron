"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Prototype .popover: fixed under its chip, closes on outside click, Escape or scroll. */
export function CatalogPopover({ anchor, onClose, className = "", label, role = "dialog", children }: { anchor: HTMLElement | null; onClose: () => void; className?: string; label: string; role?: "dialog" | "listbox"; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !box.current) return;
    const rect = anchor.getBoundingClientRect(), width = box.current.offsetWidth;
    setPosition({ top: rect.bottom + 8, left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left)) });
  }, [anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { onClose(); anchor?.focus(); } };
    const scroll = () => onClose();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, { passive: true });
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("scroll", scroll); };
  }, [anchor, onClose]);
  return <div ref={box} className={`tk-popover ${className}`} role={role} aria-label={label} style={position ? { top: position.top, left: position.left } : { visibility: "hidden", top: 0, left: 0 }}>{children}</div>;
}

export function CatalogMenu({ anchor, onClose, label, value, options, onPick }: { anchor: HTMLElement | null; onClose: () => void; label: string; value: string; options: Array<{ value: string; label: string; disabled?: boolean }>; onPick: (value: string) => void }) {
  return <CatalogPopover anchor={anchor} onClose={onClose} label={label} role="listbox">
    {options.map(option => <button key={option.value} className="tk-opt" type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} onClick={() => { onPick(option.value); onClose(); }}>
      {option.label}{option.value === value ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg> : null}
    </button>)}
  </CatalogPopover>;
}
