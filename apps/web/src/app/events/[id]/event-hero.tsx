"use client";

import { useState } from "react";
import type { PublicEvent, PublicEventMedia } from "@event-platform/shared-types";
import { PublicFramedAsset } from "../../../components/public-event-media";

/** One card: the saved 16:9 photo sits inside it with its own rounded corners, the key facts sit beside it. */
export function EventHero({ event, children, actions, galleryLabel }: { event: PublicEvent; children: React.ReactNode; actions: React.ReactNode; galleryLabel: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const images = event.media?.filter(asset => asset.kind === "image" && (asset.galleryVisible || asset.isBackground || asset.isCard)) ?? [];
  const background = event.media?.find(asset => asset.isBackground) ?? images[0];
  const legacy = [...new Set([event.posterUrl, ...(event.galleryUrls ?? [])].filter((url): url is string => Boolean(url)))];
  const options: Array<{ id: string; asset?: PublicEventMedia; url: string }> = images.length
    ? [background, ...images].filter((asset, index, all): asset is PublicEventMedia => Boolean(asset && asset.kind === "image" && all.findIndex(item => item?.id === asset.id) === index)).slice(0, 4).map(asset => ({ id: asset.id, asset, url: asset.url }))
    : legacy.slice(0, 4).map(url => ({ id: url, url: mediaUrl(url) }));
  const active = options.find(option => option.id === selected);
  const asset = active?.asset ?? (selected ? undefined : background);
  const url = active?.url ?? mediaUrl(event.posterUrl ?? "");
  const activeId = active?.id ?? background?.id ?? options[0]?.id;
  const activeIndex = Math.max(0, options.findIndex(option => option.id === activeId));

  // Prototype .hero.joined: photo stage and facts card in one white card.
  return <section className="event-hero tke-hero tke-joined">
    <div className="tke-stage">
      <div className="tke-stage-media" aria-hidden="true" key={activeId}>
        {asset ? <PublicFramedAsset asset={asset} role="background" className="h-full w-full" /> : url ? <img alt="" src={url} width={1600} height={900} className="tke-main" /> : null}
      </div>
      <div className="tke-stage-actions">{actions}</div>
      {options.length > 1 ? <div className="tke-thumbs">
        <div className="tke-thumb-row" role="group" aria-label={galleryLabel}>
          {options.map((option, index) => <button key={option.id} type="button" aria-label={`${galleryLabel}: ${index + 1}`} aria-pressed={option.id === activeId} onClick={() => setSelected(option.id)} className="event-hero-thumbnail">
            {option.asset ? <PublicFramedAsset asset={option.asset} className="h-full w-full" /> : <img alt="" src={option.url} width={56} height={42} />}
          </button>)}
        </div>
        <span className="tke-count">{activeIndex + 1} / {options.length}</span>
      </div> : null}
    </div>
    <div className="tke-facts-card">{children}</div>
  </section>;
}

function mediaUrl(url: string) { return url.startsWith("/staff-api/") ? url : url ? new URL(url, process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").toString() : ""; }
