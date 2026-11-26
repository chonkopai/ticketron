"use client";
import { useEffect, useState } from "react";
import { apiBlobRequest } from "../app/(auth)/_lib/api";
import type { PublicEventMedia } from "@event-platform/shared-types";
import { FramedMedia } from "./event-creation/framed-media";
export function PublicFramedAsset({asset,className="",controls=false}:{asset:PublicEventMedia;role?:"card"|"featured"|"background"|"gallery";className?:string;controls?:boolean}){
 const crop=asset.crops.card;
 return <div className={className}><FramedMedia src={asset.url} poster={asset.posterUrl??undefined} kind={asset.kind} width={asset.width} height={asset.height} crop={crop} alt={asset.caption??""} controls={controls} className="h-full w-full"/></div>;
}

export function EventCardMedia({ asset, posterUrl, ownerPreview = false }: {
  asset?: PublicEventMedia | undefined;
  posterUrl: string | null;
  ownerPreview?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<{ source: string; url: string } | null>(null);
  const source = asset?.kind === "video" ? asset.posterUrl : asset?.url;
  useEffect(() => setFailed(false), [posterUrl]);
  useEffect(() => {
    if (!ownerPreview || !source) return;
    const controller = new AbortController();
    let url: string | undefined;
    void apiBlobRequest(`${source}/owner`, { signal: controller.signal }).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ source, url });
    }).catch(() => undefined);
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [ownerPreview, source]);

  if (asset && !ownerPreview) return <PublicFramedAsset asset={asset} className="h-full w-full" />;
  if (asset && source && preview?.source === source) {
    return <PublicFramedAsset asset={{ ...asset, kind: "image", caption: null, url: preview.url }} className="h-full w-full" />;
  }
  if ((!asset || !ownerPreview) && posterUrl && !failed) return <img alt="" className="absolute inset-0 h-full w-full object-cover" src={posterUrl} width={1600} height={900} onError={() => setFailed(true)} />;
  return <div className="absolute inset-0 bg-gradient-to-br from-violet-100 to-slate-200 dark:from-ticket-accent-soft dark:to-ticket-raised" />;
}
