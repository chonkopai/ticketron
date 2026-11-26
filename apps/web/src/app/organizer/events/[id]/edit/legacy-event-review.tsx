"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { apiRequest } from "../../../../(auth)/_lib/api";
import { EventReviewStatus } from "../../../../../components/event-review-status";
import type { OrganizerEvent } from "@event-platform/shared-types";
import { useLocale } from "../../../../../components/locale-provider";
import { localeUrl } from "../../../../../lib/locale";

const words={
  ru:{title:"Событие требует проверки",body:"Это событие использует прежний формат. Перед редактированием организатор должен проверить условия продажи, переводы, медиа и расписание. Существующие покупки, QR-билеты и возвраты доступны в управлении событием.",manage:"Управление событием",create:"Создать новое событие"},
  en:{title:"Event review required",body:"This event uses the previous format. Its sale terms, translations, media and schedule need review before editing. Existing purchases, QR tickets and refunds remain available in event management.",manage:"Manage event",create:"Create a new event"},
  kk:{title:"Іс-шараны тексеру қажет",body:"Бұл іс-шара бұрынғы форматты қолданады. Өңдемес бұрын сату шарттарын, аудармаларды, медианы және кестені тексеру қажет. Бұрынғы сатып алулар, QR-билеттер және қайтарымдар іс-шараны басқаруда қолжетімді.",manage:"Іс-шараны басқару",create:"Жаңа іс-шара құру"},
};
export function LegacyEventReview({event}:{event:OrganizerEvent}) {
  const locale=useLocale(),copy=words[locale], t=(ru:string,kk:string,en:string)=>({ru,kk,en})[locale];
  const [current,setCurrent]=useState(event),[draft,setDraft]=useState({title:event.title,description:event.description??"",address:event.address,date:event.date,time:event.time,timezone:event.timezone,program:event.program??"",rules:event.rules??"",visitTerms:event.visitTerms??"",cancellationTerms:event.cancellationTerms??"",extraConditions:event.extraConditions??""});
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[saved,setSaved]=useState(false);
  const fields={title:t("Название","Атауы","Title"),description:t("Описание","Сипаттама","Description"),address:t("Адрес","Мекенжай","Address"),date:t("Дата","Күні","Date"),time:t("Время","Уақыт","Time"),timezone:t("Часовой пояс","Уақыт белдеуі","Timezone")};
  const extra={program:t("Программа","Бағдарлама","Program"),rules:t("Правила","Ережелер","Rules"),visitTerms:t("Условия посещения","Қатысу шарттары","Visit terms"),cancellationTerms:t("Условия отмены и возврата","Бас тарту және қайтару шарттары","Cancellation and refund terms"),extraConditions:t("Дополнительные условия","Қосымша шарттар","Additional terms")};
  async function submit(e:FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError("");setSaved(false);try{const result=await apiRequest<OrganizerEvent>(`/api/organizer/events/${event.id}/review-content`,{method:"POST",body:JSON.stringify({...draft,revision:current.revision??1})});setCurrent(result);setSaved(true);}catch{setError(t("Не удалось отправить изменения. Обновите страницу и повторите попытку.","Өзгерістер жіберілмеді. Бетті жаңартып, қайталаңыз.","Could not submit changes. Refresh the page and retry."));}finally{setBusy(false);}}
  return <main className="organizer-event-page tk-review">
    <Link className="tk-back-link" href={localeUrl(`/organizer/events/${event.id}`,locale)}>← {copy.manage}</Link>
    <header className="tk-review-head"><div><p className="tk-review-eyebrow">{copy.title}</p><h1>{current.title}</h1></div><EventReviewStatus event={current}/></header>
    <p className="tk-review-note">{t("Исправьте данные и отправьте мероприятие на проверку. Условия существующих покупок сохранятся.","Деректерді түзетіп, іс-шараны тексеруге жіберіңіз. Бұрынғы сатып алу шарттары сақталады.","Correct the details and submit the event for review. Existing purchase terms are preserved.")}</p>
    {current.moderationReason ? <p className="tk-review-note is-warning">{current.moderationReason}</p> : null}
    <form className="tk-review-form" onSubmit={e=>void submit(e)}><fieldset disabled={busy} className="tk-review-fields">
      {(Object.keys(fields) as Array<keyof typeof fields>).map(key=><label className={`tk-review-field ${key==="title"||key==="description"||key==="address"?"is-wide":""}`} key={key}><span>{fields[key]}</span>{key==="description"?<textarea required rows={5} maxLength={20000} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/>:<input required type={key==="date"?"date":key==="time"?"time":"text"} maxLength={key==="title"?160:key==="address"?250:undefined} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/>}</label>)}
      <details className="tk-review-more is-wide"><summary>{t("Дополнительные сведения","Қосымша мәліметтер","Additional details")}</summary><div className="tk-review-fields">{(Object.keys(extra) as Array<keyof typeof extra>).map(key=><label key={key} className="tk-review-field is-wide"><span>{extra[key]}</span><textarea rows={3} maxLength={20000} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}</div></details>
    </fieldset>{error?<p className="tk-review-note is-error" role="alert">{error}</p>:null}{saved?<p className="tk-review-note is-success" role="status">{t("Мероприятие отправлено на проверку.","Іс-шара тексеруге жіберілді.","Event submitted for review.")}</p>:null}
    <div className="tk-review-actions"><button className="tk-review-submit" disabled={busy}>{busy?t("Отправка…","Жіберілуде…","Submitting…"):t("Отправить на проверку","Тексеруге жіберу","Submit for review")}</button></div></form></main>;
}
