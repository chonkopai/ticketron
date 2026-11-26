"use client";
import type {HomepageAdEvent,EventLocale} from "@event-platform/shared-types";
import {PublicFramedAsset} from "./public-event-media";
import {useLocale} from "./locale-provider";
import {INTL_LOCALES} from "../lib/locale";
export function homepageAdDate(event:HomepageAdEvent,locale:EventLocale) {
 try{return new Intl.DateTimeFormat(INTL_LOCALES[locale],{dateStyle:"medium",timeStyle:"short",timeZone:event.timezone}).format(new Date(event.startsAt));}catch{return `${event.date} ${event.time}`;}
}
export function HomepageAdBanner({event,staff=false,featured=false}:{event:HomepageAdEvent;staff?:boolean;featured?:boolean}) {
 const locale=useLocale(),asset=event.media?.find(item=>item.isCard)??event.media?.find(item=>item.kind==="image");
 const source=asset?.kind==="video"?asset.posterUrl:asset?.url;
 const url=(value:string)=>staff&&value.startsWith(`/media/events/${event.id}/`)?value.replace(`/media/events/${event.id}/`,`/staff-api/events/${event.id}/media/`):staff&&value.startsWith("/media/")?new URL(value,process.env.NEXT_PUBLIC_API_URL??"http://localhost:3001").toString():value;
 return <div className={`flex h-full min-w-0 items-center ${featured?"gap-4 sm:gap-7":"gap-3 sm:gap-4"}`}>
  <div className={`relative h-full shrink-0 overflow-hidden bg-violet-100 dark:bg-ticket-raised ${featured?"w-28 sm:w-60":"w-20 rounded-md sm:w-28"}`} aria-hidden="true">
   {asset&&source?<PublicFramedAsset asset={{...asset,kind:"image",url:url(source)}} className="h-full w-full"/>:event.posterUrl?<img alt="" src={url(event.posterUrl)} width={1600} height={900} className="h-full w-full object-cover" onError={e=>{e.currentTarget.hidden=true;}}/>:<svg className="m-auto h-full w-7 text-violet-400" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Z"/></svg>}
  </div>
  <div className={`min-w-0 flex-1 text-left ${featured?"py-8 pr-4 sm:pr-10":""}`}><p className={`font-semibold text-slate-900 dark:text-ticket-text ${featured?"line-clamp-2 text-lg leading-tight tracking-tight sm:text-2xl":"truncate text-sm sm:text-base"}`}>{event.title}</p><time className={`block truncate text-slate-600 dark:text-ticket-muted ${featured?"mt-2 text-xs leading-5 sm:text-sm":"text-[11px] leading-4 sm:text-xs"}`} dateTime={event.startsAt||`${event.date}T${event.time}`}>{homepageAdDate(event,locale)}</time><p className={`truncate text-slate-600 dark:text-ticket-muted ${featured?"text-xs leading-5 sm:text-sm":"text-[11px] leading-4 sm:text-xs"}`}>{[...new Set([event.city,event.address].filter(Boolean))].join(" · ")}</p></div>
 </div>;
}
