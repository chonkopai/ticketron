import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionDialog } from "../app/admin/staff-ui";
import { EventReviewStatus } from "../components/event-review-status";
import { LocaleProvider } from "../components/locale-provider";
import { CurrencyProvider } from "../components/currency-provider";
import PublicEventPage from "../app/events/[id]/event-client";
import { draftEventPreview } from "./draft-event-preview";
import { newEventCreationDraft } from "@event-platform/shared-types";

test("moderation reasons are optional while other admin dialogs retain their validation", () => {
  const render = (optionalReason:boolean) => renderToStaticMarkup(<ActionDialog title="Отклонить: Концерт" optionalReason={optionalReason} onClose={()=>{}} onSubmit={async()=>{}}><p>Details</p></ActionDialog>);
  assert.match(render(true), /Причина или комментарий — необязательно/);
  assert.doesNotMatch(render(true), /required=""|minLength=/);
  assert.match(render(false), /required=""/);
});
test("review badges use the same Russian copy across admin and organizer views",()=>{
  const html=renderToStaticMarkup(<LocaleProvider locale="ru"><EventReviewStatus event={{status:"published",moderationStatus:"sales_paused",approvedAt:"2026-11-16",salesPaused:true}}/></LocaleProvider>);
  assert.match(html,/Опубликовано · продажи остановлены/);
});
test("admin preview renders the real public page with readable content and disabled transactions",()=>{
  const draft=newEventCreationDraft("10000000-0000-4000-8000-000000000001","ru");draft.schedule={startLocal:"2031-12-01T20:00",endLocal:"2031-12-01T23:00",timezone:"Asia/Almaty",startChoice:null,endChoice:null};draft.selectedMode="free";draft.content.ru={title:"Концерт",description:"Описание",address:"Адрес"};draft.free.content.ru={name:"Приглашение"};draft.free.capacity=10;
  const model=draftEventPreview("10000000-0000-4000-8000-000000000001",draft,"ru",[],{title:"Title",address:"Address",invitation:"Invite"});
  const html=renderToStaticMarkup(<LocaleProvider locale="ru"><CurrencyProvider><PublicEventPage id={model.event.id} preview={{...model,interactive:true,descriptionPlaceholder:"",emptyTickets:"",showRefund:true}}/></CurrencyProvider></LocaleProvider>);
  assert.match(html,/event-hero/);assert.match(html,/event-details-grid/);assert.match(html,/class="checkout-primary" disabled=""/);assert.match(html,/Концерт/);
  assert.doesNotMatch(html,/inert=""/);assert.doesNotMatch(html,/guest-inline/);
});

test("paused public sales display an explanation instead of a purchase flow",async()=>{
  const { CheckoutPanel }=await import("../app/events/[id]/checkout-panel");
  const event={id:"event",salesPaused:true,ticketTypes:[],tables:[],paymentMode:"full_payment",sourceLocale:"ru",contentLocale:"ru"} as unknown as import("@event-platform/shared-types").PublicEvent;
  const html=renderToStaticMarkup(<LocaleProvider locale="ru"><CurrencyProvider><CheckoutPanel event={event} layout={null} selectedSeatIds={[]} selectedTableId={null} onTableChange={()=>{}} ticketQuantities={{}} onTicketChange={()=>{}} onClearSeats={()=>{}} onRefreshAvailability={async()=>{}}/></CurrencyProvider></LocaleProvider>);
  assert.match(html,/Продажи и регистрация временно остановлены/);assert.doesNotMatch(html,/checkout-primary|guest-inline/);
});
