import assert from "node:assert/strict";
import {test} from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import type {HomepageAdEvent} from "@event-platform/shared-types";
import {LocaleProvider} from "../components/locale-provider";
import {HomepageAdBanner,homepageAdDate} from "../components/homepage-ad-banner";
import {PromotionCarousel} from "../components/promotion-carousel";
import {StaffHomepageAdvertisements} from "../app/admin/homepage-advertisements";
const event:HomepageAdEvent={id:"10000000-0000-4000-8000-000000000001",title:"Концерт в Алматы",posterUrl:"/poster.jpg",date:"2035-01-01",time:"18:00",startsAt:"2035-01-01T13:00:00Z",timezone:"Asia/Almaty",address:"Проспект Абая, 10",city:"Алматы",countryCode:"KZ"};
test("advertisement previews use the existing event title, cover, location and event timezone",()=>{
 const html=renderToStaticMarkup(<LocaleProvider locale="ru"><HomepageAdBanner event={event}/></LocaleProvider>);
 for(const value of [event.title,event.posterUrl!,event.address,event.city,"18:00"])assert.ok(html.includes(value));
 assert.ok(homepageAdDate(event,"en").includes("6:00"));
});
test("normalized staff cover previews keep protected event media on the staff route",()=>{
 const normalized={...event,posterUrl:`/media/events/${event.id}/asset/display`};
 const html=renderToStaticMarkup(<LocaleProvider locale="ru"><HomepageAdBanner event={normalized} staff/></LocaleProvider>);
 assert.ok(html.includes(`/staff-api/events/${event.id}/media/asset/display`));
});
test("the promo carousel keeps its advertisement label and loading state, with progress bars only once ads load",()=>{
 for(const [locale,label,loading] of [["ru","Реклама","Загружаем рекламу"],["kk","Жарнама","Жарнама жүктелуде"],["en","Advertisement","Loading advertisements"]] as const){
  const html=renderToStaticMarkup(<LocaleProvider locale={locale}><PromotionCarousel/></LocaleProvider>);
  assert.ok(html.includes(label));assert.ok(html.includes(loading));assert.match(html,/aria-roledescription="carousel"/);assert.match(html,/aria-busy="true"/);assert.doesNotMatch(html,/tk-bar-hit/);
 }
});
test("admin placements and eligible search have independent loading states",()=>{
 const html=renderToStaticMarkup(<LocaleProvider locale="ru"><StaffHomepageAdvertisements/></LocaleProvider>);
 assert.match(html,/Выбранные мероприятия/);assert.match(html,/Поиск мероприятий для рекламы/);assert.equal((html.match(/role="status"/g)??[]).length,2);
});
