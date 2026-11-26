"use client";
import {useRef,useState} from "react";
import type {AdminHomepageAdList,HomepageAdList} from "@event-platform/shared-types";
import {HomepageAdBanner} from "../../components/homepage-ad-banner";
import {useLocale} from "../../components/locale-provider";
import {staffRequest,errorText} from "./staff-client";
import {ResourceState,useResource,useText} from "./staff-ui";
import {StaffIcon} from "./staff-icon";
export function StaffHomepageAdvertisements() {
 const t=useText(),locale=useLocale(),[search,setSearch]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),pending=useRef(false);
 const placements=useResource<AdminHomepageAdList>(`homepage-ads?locale=${locale}`),candidates=useResource<HomepageAdList>(`homepage-ads/events?locale=${locale}&search=${encodeURIComponent(search)}`);
 const chosen=new Set(placements.data?.items.map(item=>item.eventId)??[]);
 async function change(path:string,body:unknown,method="POST") {
  if(pending.current)return;pending.current=true;setBusy(true);setError("");setNotice("");
  try{const result=await staffRequest<AdminHomepageAdList>(`${path}${path.includes("?")?"&":"?"}locale=${locale}`,body,method);placements.setData(result);setNotice(t("Изменения сохранены","Өзгерістер сақталды","Changes saved"));}
  catch(value){const code=value instanceof Error?value.message:"";setError(code==="HOMEPAGE_AD_INELIGIBLE"?t("Это мероприятие больше не доступно для рекламы. Выберите опубликованное и одобренное мероприятие.","Бұл іс-шара енді жарнамаға жарамсыз. Жарияланған және мақұлданған іс-шараны таңдаңыз.","This event is no longer eligible. Choose an approved, publicly published event."):code==="HOMEPAGE_AD_DUPLICATE"?t("Мероприятие уже добавлено. Обновите список.","Іс-шара қосылған. Тізімді жаңартыңыз.","This event is already selected. Refresh the list."):errorText(value,locale));}
  finally{pending.current=false;setBusy(false);}
 }
 return <>
  <section className="staff-card"><h2>{t("Выбранные мероприятия","Таңдалған іс-шаралар","Selected events")}</h2><p className="staff-muted">{t("Реклама показывается в существующей полосе под календарём на главной. Изменения сохраняются сразу.","Жарнама басты беттегі күнтізбе астындағы жолақта көрсетіледі. Өзгерістер бірден сақталады.","Advertisements appear in the existing bar below the homepage calendar. Changes save immediately.")}</p>
   {busy?<p role="status">{t("Сохраняем…","Сақталуда…","Saving…")}</p>:notice?<p className="staff-success" role="status">{notice}</p>:null}{error?<p className="staff-error" role="alert">{error}</p>:null}<ResourceState error={placements.error} loading={!placements.data} onRetry={placements.retry}/>
   {placements.data?.items.length===0?<p className="staff-ad-empty">{t("Пока ничего не выбрано. На главной отображается стандартная заглушка рекламы.","Әзірге ештеңе таңдалмаған. Басты бетте стандартты жарнама орны көрсетіледі.","No events selected. The homepage shows its existing advertisement placeholder.")}</p>:null}
   <ol className="staff-ad-placements">{placements.data?.items.map((item,index)=><li key={item.eventId} className={item.eligible?"":"is-ineligible"}><div className="staff-ad-preview"><span className="staff-ad-label">{t("Реклама","Жарнама","Advertisement")} · {index+1}</span><HomepageAdBanner event={item.event} staff/></div>
    {!item.eligible?<p className="staff-ad-warning">{t("Не показывается на главной: мероприятие больше не опубликовано или не одобрено.","Басты бетте көрсетілмейді: іс-шара енді жарияланбаған немесе мақұлданбаған.","Not shown on the homepage: the event is no longer approved or publicly published.")}</p>:null}
    <div className="staff-actions"><button disabled={busy||index===0} aria-label={`${t("Выше","Жоғары","Move up")}: ${item.event.title}`} onClick={()=>void change(`homepage-ads/${item.eventId}`,{direction:"up"},"PATCH")}><StaffIcon name="up"/>{t("Выше","Жоғары","Up")}</button><button disabled={busy||index===(placements.data?.items.length??0)-1} aria-label={`${t("Ниже","Төмен","Move down")}: ${item.event.title}`} onClick={()=>void change(`homepage-ads/${item.eventId}`,{direction:"down"},"PATCH")}><StaffIcon name="down"/>{t("Ниже","Төмен","Down")}</button><button className="staff-danger" disabled={busy} aria-label={`${t("Убрать из рекламы","Жарнамадан алу","Remove advertisement")}: ${item.event.title}`} onClick={()=>void change(`homepage-ads/${item.eventId}`,undefined,"DELETE")}><StaffIcon name="reject"/>{t("Убрать","Алып тастау","Remove")}</button></div>
   </li>)}</ol>
  </section>
  <section className="staff-card"><h2>{t("Добавить мероприятие","Іс-шара қосу","Add an event")}</h2><p className="staff-muted">{t("Только одобренные мероприятия, доступные в публичной афише. Поиск показывает до 20 результатов.","Тек мақұлданған және жария афишада қолжетімді іс-шаралар. Іздеу 20 нәтижеге дейін көрсетеді.","Only approved, publicly visible events. Search shows up to 20 results.")}</p><input type="search" aria-label={t("Поиск мероприятий для рекламы","Жарнамаға іс-шара іздеу","Search events to advertise")} placeholder={t("Название мероприятия","Іс-шара атауы","Event title")} value={search} onChange={e=>setSearch(e.target.value)}/><ResourceState error={candidates.error} loading={!candidates.data} onRetry={candidates.retry}/>
   {candidates.data?.items.length===0?<p>{t("Подходящих мероприятий не найдено","Жарамды іс-шаралар табылмады","No eligible events found")}</p>:null}<ul className="staff-ad-candidates">{candidates.data?.items.map(event=><li key={event.id}><div className="staff-ad-preview"><HomepageAdBanner event={event} staff/></div><button className="staff-primary" disabled={busy||!placements.data||chosen.has(event.id)} aria-label={`${t("Добавить в рекламу","Жарнамаға қосу","Add advertisement")}: ${event.title}`} onClick={()=>void change("homepage-ads",{eventId:event.id})}><StaffIcon name="approve"/>{chosen.has(event.id)?t("Добавлено","Қосылған","Added"):t("Добавить","Қосу","Add")}</button></li>)}</ul>
  </section>
 </>;
}
