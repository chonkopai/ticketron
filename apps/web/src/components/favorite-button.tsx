"use client";

import { ru } from "@event-platform/shared-types";
import { useEffect, useState } from "react";

import { loadFavoriteIds, toggleFavorite } from "../lib/favorites";
import { readLocalFavoriteIds } from "../lib/local-preferences";

export function FavoriteButton({ eventId, compact = false, heroOverlay = false, readOnly = false }: { eventId: string; compact?: boolean; heroOverlay?: boolean; readOnly?: boolean }) {
  const [favorite, setFavorite] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (readOnly) return;
    let active = true;
    void loadFavoriteIds().then((ids) => { if (active) setFavorite(ids.has(eventId)); }).catch(() => {
      if (active) setFavorite(readLocalFavoriteIds().includes(eventId));
    });
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ eventId?: string; favorite?: boolean }>).detail;
      if (detail?.eventId === eventId && typeof detail.favorite === "boolean") setFavorite(detail.favorite);
      else setFavorite(readLocalFavoriteIds().includes(eventId));
    };
    window.addEventListener("event-platform:favorites-changed", refresh);
    return () => { active = false; window.removeEventListener("event-platform:favorites-changed", refresh); };
  }, [eventId, readOnly]);

  async function change(): Promise<void> {
    if (busy || readOnly) return;
    const next = !favorite;
    setBusy(true);
    setFavorite(next);
    try {
      await toggleFavorite(eventId, next);
      window.dispatchEvent(new CustomEvent("event-platform:favorites-changed", { detail: { eventId, favorite: next } }));
    } catch {
      setFavorite(!next);
    } finally { setBusy(false); }
  }

  return <button aria-label={favorite ? ru.publicEvent.favoriteRemove : ru.publicEvent.favoriteAdd} aria-pressed={favorite} className={`ticket-fav ${compact ? "ticket-fav-compact" : heroOverlay ? "ticket-fav-hero" : "ticket-fav-default"}`} disabled={busy} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void change(); }} type="button"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20.2s-7.8-4.6-7.8-10.4A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 7.8 2.8c0 5.8-7.8 10.4-7.8 10.4Z" /></svg></button>;
}
