"use client";
import {Fragment,useState} from "react";
import type {Paged} from "@event-platform/shared-types";
import {useLocale} from "../../components/locale-provider";
import {INTL_LOCALES} from "../../lib/locale";
import {auditAction,auditChanges,auditObject,auditTargetLabel} from "../../lib/staff-audit-copy";
import {StaffIcon} from "./staff-icon";
import {Pager,ResourceState,useResource,useText,type Row} from "./staff-ui";
export function StaffActivity({onOpen}:{onOpen?:(type:string,id:string)=>void}) {
 const t=useText(),[search,setSearch]=useState(""),[page,setPage]=useState(1);
 const resource=useResource<Paged<Row>>(`audit?page=${page}&search=${encodeURIComponent(search)}`);
 return <section className="staff-card staff-audit-log">
 <div className="staff-audit-toolbar">
   <p className="staff-muted">{t("История действий сотрудников. Технические данные сохранены в подробностях.","Қызметкер әрекеттерінің тарихы. Техникалық деректер толық мәліметтерде сақталған.","Staff activity history. Technical records are retained in the details.")}</p>
   <div className="staff-audit-search">
     <StaffIcon name="search" />
     <input type="search" aria-label={t("Поиск в журнале","Журналдан іздеу","Search activity log")} placeholder={t("Сотрудник, название объекта или код действия","Қызметкер, нысан атауы немесе әрекет коды","Staff member, record name or action code")} value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/>
   </div>
 </div>
 <ResourceState error={resource.error} loading={!resource.data} onRetry={resource.retry}/>
 {resource.data?<><AuditLogTable rows={resource.data.items} onOpen={onOpen}/><Pager page={page} total={resource.data.total} limit={20} onPage={setPage}/></>:null}</section>;
}
function AuditLogTable({rows,onOpen}:{rows:Row[];onOpen:((type:string,id:string)=>void)|undefined}) {
 const t=useText(),locale=useLocale(),[expanded,setExpanded]=useState<string|null>(null);
 if(!rows.length) return <p className="staff-muted">{t("Записей пока нет","Әзірге жазба жоқ","No records yet")}</p>;
 return <div className="staff-table-wrap"><table><thead><tr>{[t("Дата и время","Күні мен уақыты","Date and time"),t("Сотрудник","Қызметкер","Employee"),t("Действие","Әрекет","Action"),t("Объект","Нысан","Record"),t("Причина / комментарий","Себеп / түсініктеме","Reason / comment"),t("Изменения","Өзгерістер","Changes")].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row=>{
  const id=String(row.id),target=auditObject(row.target),name=[auditTargetLabel(row.targetType,locale),target.reference,target.name].filter(Boolean).join(" · "),when=new Date(String(row.createdAt));
  return <Fragment key={id}><tr>
   <td>{Number.isNaN(when.getTime())?"—":<time dateTime={when.toISOString()}>{new Intl.DateTimeFormat(INTL_LOCALES[locale],{dateStyle:"medium",timeStyle:"short"}).format(when)}</time>}</td>
   <td>{row.staffId?String(auditObject(row.staff).name||t("Сотрудник (историческая запись)","Қызметкер (тарихи жазба)","Staff member (historical record)")):t("Система","Жүйе","System")}</td>
   <td>{auditAction(row,locale)}</td>
   <td>{onOpen&&target.available&&["event","case","verification","user","order","staff"].includes(String(row.targetType))?<button className="staff-link" onClick={()=>onOpen(String(row.targetType),String(row.targetId))}>{name}</button>:name}</td>
   <td>{typeof row.reason==="string"&&row.reason.trim()?row.reason:"—"}</td>
   <td><button className="staff-link" aria-expanded={expanded===id} aria-controls={`audit-details-${id}`} onClick={()=>setExpanded(expanded===id?null:id)}>{t("Подробности","Толық мәліметтер","Details")} {expanded===id?"−":"+"}</button></td>
  </tr>{expanded===id?<tr className="staff-audit-expanded" id={`audit-details-${id}`}><td colSpan={6}><AuditChangeContent row={row}/></td></tr>:null}</Fragment>;
 })}</tbody></table></div>;
}
export function AuditDetails({row}:{row:Row}) {
 const t=useText();
 return <details className="staff-audit-details"><summary>{t("Подробности","Толық мәліметтер","Details")}</summary><AuditChangeContent row={row}/></details>;
}
function AuditChangeContent({row}:{row:Row}) {
 const t=useText(),locale=useLocale(),changes=auditChanges(row,locale);
 return <div className="staff-audit-details">{changes.length?<div className="staff-audit-change-list"><table><thead><tr><th>{t("Поле","Өріс","Field")}</th><th>{t("Было","Бұрын","Before")}</th><th>{t("Стало","Кейін","After")}</th></tr></thead><tbody>{changes.map(change=><tr key={change.key}><th scope="row">{change.label}</th><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table></div>:<p className="staff-muted">{t("Отдельные значения до и после действия не записаны или не изменились.","Әрекетке дейінгі және кейінгі жеке мәндер жазылмаған немесе өзгермеген.","Separate before/after values were not recorded or did not change.")}</p>}<details><summary>{t("Технические данные","Техникалық деректер","Technical data")}</summary><dl><dt>{t("Код действия","Әрекет коды","Action code")}</dt><dd>{String(row.action)}</dd><dt>{t("Тип и ID объекта","Нысан түрі және ID","Record type and ID")}</dt><dd>{String(row.targetType)} · {String(row.targetId)}</dd><dt>{t("ID записи журнала","Журнал жазбасының ID","Audit record ID")}</dt><dd>{String(row.id)}</dd><dt>{t("ID сотрудника","Қызметкер ID","Staff ID")}</dt><dd>{row.staffId?String(row.staffId):"—"}</dd></dl><pre>{JSON.stringify({before:row.before??null,after:row.after??null},null,2)}</pre></details></div>;
}
