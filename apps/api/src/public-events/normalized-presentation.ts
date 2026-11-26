import type { Event,Prisma } from "@event-platform/database";
import { readMediaCrop,mediaRoleCrops,selectContentLocale,type EventLocale,type PublicEvent,type PublicEventMedia } from "@event-platform/shared-types";
import { eventAggregate,normalizedEvent } from "../creation-drafts/event-aggregate.js";
export function visibleResourceDescription(text:{description:string|null;fieldMetadata:Prisma.JsonValue}|undefined){
 const metadata=text?.fieldMetadata;const description=metadata&&typeof metadata==="object"&&!Array.isArray(metadata)?metadata.description:null;
 return description&&typeof description==="object"&&!Array.isArray(description)&&description.stale===true?null:text?.description??null;
}
type EventMediaLink = Prisma.EventMediaGetPayload<{ include: { asset: true } }>;

export function presentEventMedia(eventId: string, link: EventMediaLink, caption: string | null = null): PublicEventMedia {
 const path = `/media/events/${eventId}/${link.assetId}`;
 return {
   id: link.assetId, slot: link.slot, kind: link.asset.kind as "image" | "video",
   width: link.asset.width!, height: link.asset.height!, url: `${path}/display`,
   posterUrl: link.asset.kind === "video" ? `${path}/poster` : null,
   isCard: link.isCard, isBackground: link.isBackground, galleryVisible: link.galleryVisible,
   crops: mediaRoleCrops(readMediaCrop(link.crops, link.isBackground && !link.isCard ? "backgroundDesktop" : "card")),
   caption,
 };
}

export async function normalizedPresentation(database:Prisma.TransactionClient,event:Event,requested:EventLocale){
 if(!normalizedEvent(event))return null;const draft=await eventAggregate(database,event),selection=selectContentLocale(draft,requested),locale=selection.locale,content=draft.content[locale]!;
 const links=await database.eventMedia.findMany({where:{eventId:event.id},include:{asset:true},orderBy:{slot:"asc"}});
 const media=links.map(link=>presentEventMedia(event.id, link,
   draft.metadata[locale]?.[`media.${link.assetId}.caption`]?.stale ? null : draft.media.captions[link.assetId]?.[locale] ?? null));
 const types=await database.ticketTypeContent.findMany({where:{ticketType:{eventId:event.id},locale}}),tables=await database.tableContent.findMany({where:{table:{venueLayout:{eventId:event.id}},locale}});
 const localizedTickets=(items:PublicEvent["ticketTypes"])=>items.map(item=>{const text=types.find(row=>row.ticketTypeId===item.id);return {...item,name:text?.name??"",description:visibleResourceDescription(text)};});
 const localizedTables=(items:PublicEvent["tables"])=>items.map(item=>{const text=tables.find(row=>row.tableId===item.id);return {...item,name:text?.name??null,description:visibleResourceDescription(text),typeLabel:text?.name??null,shortDescription:visibleResourceDescription(text)};});
 return {fields:{creationVersion:2 as const,saleMode:event.saleMode!,currency:event.currency!.trim(),title:content.title!,description:content.description!,address:content.address!,program:null,rules:null,visitTerms:null,extraConditions:null,depositTerms:null,cancellationTerms:event.refundsAvailable?content.refundConditions??null:null,refundsAvailable:event.refundsAvailable!,refundPolicyRevision:event.refundPolicyRevision,startsAt:event.startsAt!.toISOString(),endsAt:event.endsAt?.toISOString()??null,sourceLocale:draft.sourceLocale,contentLocale:locale,media,posterUrl:media.find(item=>item.isCard)?.url??null,galleryUrls:media.filter(item=>item.galleryVisible).map(item=>item.url)},localizedTickets,localizedTables};
}

type PresentationFields=NonNullable<Awaited<ReturnType<typeof normalizedPresentation>>>["fields"];

/**
 * Batched variant of {@link normalizedPresentation} for catalogue pages: loads the
 * aggregate inputs of every normalized event with one query per table, then runs
 * the unchanged single-event code against an in-memory view of those rows, so the
 * fields are identical. Events that are not normalized are absent from the result.
 * Only the summary fields are produced (ticket and table content is not loaded).
 */
export async function normalizedPresentationFields(database:Prisma.TransactionClient,events:Event[],requested:EventLocale):Promise<Map<string,PresentationFields>>{
 const result=new Map<string,PresentationFields>(),targets=events.filter(event=>normalizedEvent(event));
 if(!targets.length)return result;
 const ids=targets.map(event=>event.id),seatedIds=targets.filter(event=>event.saleMode==="paid_seated").map(event=>event.id);
 const [drafts,contents,types,layouts,links]=await Promise.all([
  database.eventCreationDraft.findMany({where:{resultEventId:{in:ids}}}),
  database.eventContent.findMany({where:{eventId:{in:ids}}}),
  database.ticketType.findMany({where:{eventId:{in:ids},isInternal:false,venueObjectId:null},include:{contents:true}}),
  seatedIds.length?database.venueLayout.findMany({where:{eventId:{in:seatedIds}},include:{tariffs:{include:{contents:true}}}}):Promise.resolve([]),
  database.eventMedia.findMany({where:{eventId:{in:ids}},include:{asset:{include:{contents:true}}},orderBy:{slot:"asc"}}),
 ]);
 const group=<T,K>(rows:T[],key:(row:T)=>K)=>{const map=new Map<K,T[]>();for(const row of rows){const list=map.get(key(row));if(list)list.push(row);else map.set(key(row),[row]);}return map;};
 const draftBy=new Map(drafts.map(row=>[row.resultEventId,row])),layoutBy=new Map(layouts.map(row=>[row.eventId,row]));
 const contentsBy=group(contents,row=>row.eventId),typesBy=group(types,row=>row.eventId),linksBy=group(links,row=>row.eventId);
 const view={
  eventCreationDraft:{findUnique:async({where}:{where:{resultEventId:string}})=>draftBy.get(where.resultEventId)??null},
  eventContent:{findMany:async({where}:{where:{eventId:string}})=>contentsBy.get(where.eventId)??[]},
  ticketType:{findMany:async({where}:{where:{eventId:string}})=>typesBy.get(where.eventId)??[]},
  venueLayout:{findUnique:async({where}:{where:{eventId:string}})=>layoutBy.get(where.eventId)??null},
  eventMedia:{findMany:async({where}:{where:{eventId:string}})=>linksBy.get(where.eventId)??[]},
  ticketTypeContent:{findMany:async()=>[]},
  tableContent:{findMany:async()=>[]},
 } as unknown as Prisma.TransactionClient;
 for(const event of targets){const presented=await normalizedPresentation(view,event,requested);if(presented)result.set(event.id,presented.fields);}
 return result;
}
