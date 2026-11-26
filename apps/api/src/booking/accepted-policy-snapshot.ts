import { assertCurrentSale } from "../events/current-sale-policy.js";
import type { Event,Prisma } from "@event-platform/database";
import { purchaseSnapshotV2Schema,selectContentLocale,type BotCheckoutQuote,type CheckoutSnapshot,type EventLocale,type TelegramSeatQuote } from "@event-platform/shared-types";
import { ConflictException } from "@nestjs/common";
import { eventAggregate,normalizedEvent } from "../creation-drafts/event-aggregate.js";
import { assertEventRegistrationOpen } from "../events/event-registration-policy.js";
import { saleEventWhere } from "../events/event-moderation-policy.js";

export async function acceptedSnapshot(tx:Prisma.TransactionClient,event:Event,snapshot:CheckoutSnapshot,input:{contentLocale?:EventLocale|undefined;policyRevision?:number|undefined},now:Date,offer?:BotCheckoutQuote | TelegramSeatQuote):Promise<Prisma.InputJsonValue>{
 if(offer){
  await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${event.id}::uuid FOR SHARE`;
  const current=await tx.event.findFirst({where:{id:event.id,...saleEventWhere}});
  if(!current)throw new ConflictException({code:"EVENT_SALES_PAUSED"});
  assertEventRegistrationOpen(current,now);
  event=current;
 }
 assertCurrentSale(event);
 if(!normalizedEvent(event)){
  if(offer)assertQuotedOffer(offer,snapshot,event.sourceLocale,event.cancellationTerms,null,null);
  return JSON.parse(JSON.stringify(offer?{...snapshot,cancellationTerms:event.cancellationTerms}:snapshot)) as Prisma.InputJsonValue;
 }
 if(!offer)await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${event.id}::uuid FOR SHARE`;
 const current=offer?event:await tx.event.findUniqueOrThrow({where:{id:event.id}});assertCurrentSale(current);if(current.status!=="published")throw new ConflictException({code:"EVENT_NOT_PUBLISHED"});
 if(current.creationVersion===2&&input.policyRevision!==current.refundPolicyRevision)throw new ConflictException({code:"REFUND_POLICY_CHANGED",message:"Refresh and accept the current policy before purchasing"});
 const draft=await eventAggregate(tx,current),selection=selectContentLocale(draft,input.contentLocale??draft.sourceLocale),locale=selection.locale,content=draft.content[locale]!;
 if(current.creationVersion===2&&input.contentLocale&&locale!==input.contentLocale)throw new ConflictException({code:"EVENT_PRESENTATION_CHANGED",message:"Refresh the event and accept its displayed language before purchasing"});
 if(offer)assertQuotedOffer(offer,snapshot,locale,current.refundsAvailable?content.refundConditions??null:null,current.refundsAvailable,current.refundPolicyRevision);
 const oldItems=snapshot.items??[{id:snapshot.itemId,kind:snapshot.itemKind==="table"?"table" as const:"ticket" as const,name:snapshot.itemName,quantity:snapshot.quantity,amountDue:snapshot.amountDue}];
 const items=await Promise.all(oldItems.map(async item=>{let name=item.name;if(item.kind==="ticket"){const text=await tx.ticketTypeContent.findUnique({where:{ticketTypeId_locale:{ticketTypeId:item.id,locale}}});if(text?.name)name=text.name;}else if(item.kind==="table"){const text=await tx.tableContent.findUnique({where:{tableId_locale:{tableId:item.id,locale}}});if(text?.name)name=text.name;}else{const seat=await tx.seat.findUnique({where:{id:item.id},include:{ticketType:{include:{contents:{where:{locale}}}}}});name=[seat?.ticketType?.contents[0]?.name,seat?`${({ru:"Место",en:"Seat",kk:"Орын"})[locale]} ${seat.number}`:undefined].filter(Boolean).join(" · ")||name;}
  const unitAmount=item.amountDue/item.quantity;if(!Number.isInteger(unitAmount))throw new ConflictException({code:"SNAPSHOT_AMOUNT_INVALID"});return {resourceId:item.id,kind:item.kind,name,quantity:item.quantity,unitAmount};}));
 const selectedSeats=snapshot.seatIds?.length?await tx.seat.findMany({where:{id:{in:snapshot.seatIds}},include:{table:{select:{number:true}},row:{select:{number:true}}}}):[];
 const seatLabels=snapshot.seatIds?.map(id=>{const seat=selectedSeats.find(item=>item.id===id);if(!seat)return "";const c=({ru:{table:"Стол",row:"Ряд",seat:"Место"},en:{table:"Table",row:"Row",seat:"Seat"},kk:{table:"Үстел",row:"Қатар",seat:"Орын"}})[locale];return [seat.table?`${c.table} ${seat.table.number}`:seat.row?`${c.row} ${seat.row.number}`:null,`${c.seat} ${seat.number}`].filter(Boolean).join(" · ");});
 const result=purchaseSnapshotV2Schema.parse({version:2,eventId:current.id,sourceLocale:draft.sourceLocale,contentLocale:locale,title:content.title,address:content.address,startsAt:current.startsAt!.toISOString(),endsAt:current.endsAt?.toISOString()??null,timezone:current.timezone,saleMode:current.saleMode,amount:snapshot.amountDue,currency:current.currency!.trim(),acceptedAt:now.toISOString(),refund:{available:current.refundsAvailable!,conditions:current.refundsAvailable?content.refundConditions??null:null,revision:current.refundPolicyRevision,locale,freeCancellation:current.saleMode==="free"},items,selection:{kind:snapshot.itemKind,...(snapshot.seatIds?{seatIds:snapshot.seatIds}:{}),...(seatLabels?{seatLabels}:{}),...(snapshot.groupPass!==undefined?{groupPass:snapshot.groupPass}:{})}});
 return JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
}

function assertQuotedOffer(offer: BotCheckoutQuote | TelegramSeatQuote, snapshot: CheckoutSnapshot, locale: string, terms: string | null, refundsAvailable: boolean | null, revision: number | null): void {
  const capacity = (snapshot.seatIds?.length ?? 0) - (snapshot.items?.filter(item => item.kind === "seat").length ?? 0);
  const matchingItems = offer.kind === "cart"
    ? snapshot.items?.length === offer.items.length && offer.items.every(item =>
      (item.kind !== "table" || item.capacity === capacity) && snapshot.items!.some(current =>
        current.kind === item.kind && current.id === item.id && current.quantity === 1 && current.amountDue === item.amount))
    : offer.itemId === snapshot.itemId;
  if (offer.eventId !== snapshot.eventId || !matchingItems || offer.kind !== snapshot.itemKind ||
      offer.amountDue !== snapshot.amountDue || offer.currency !== snapshot.currency || offer.locale !== locale ||
      offer.refundTerms !== terms || offer.refundsAvailable !== refundsAvailable || offer.policyRevision !== revision) {
    throw new ConflictException({ code: "BOT_OFFER_CHANGED" });
  }
}
