import {test} from "node:test";
import assert from "node:assert/strict";
import {renderToStaticMarkup} from "react-dom/server";
import {auditAction,auditChanges} from "./staff-audit-copy";
import {VerifiedOrganizerBadge} from "../components/verified-organizer-badge";
import {LocaleProvider} from "../components/locale-provider";
import {AuditDetails} from "../app/admin/audit-log";
import {VerificationCard} from "../app/admin/organizer-verifications";
import type {VerificationView} from "@event-platform/shared-types";
test("self-assignment requires recorded before/after evidence, not reason text",()=>{
 assert.equal(auditAction({action:"support.updated",staffId:"staff-1",before:{assignedStaffId:null},after:{assignedStaffId:"staff-1"}},"ru"),"Назначил обращение себе");
 assert.equal(auditAction({action:"support.updated",staffId:"staff-1",reason:"Assigned to myself"},"ru"),"Обновил обращение");
 assert.equal(auditAction({action:"support.updated",staffId:"staff-1",after:{assignedStaffId:"staff-1"}},"ru"),"Обновил обращение");
 assert.equal(auditAction({action:"support.updated",staffId:"staff-1",before:{assignedStaffId:null},after:{assignedStaffId:"staff-2"}},"ru"),"Изменил ответственного за обращение");
});
test("verification decisions derive from the recorded outcome with readable unknown fallbacks",()=>{
 assert.equal(auditAction({action:"verification.reviewed",after:{status:"verified"}},"ru"),"Подтвердил организатора");
 assert.equal(auditAction({action:"verification.reviewed",after:{status:"rejected"}},"ru"),"Отклонил заявку организатора");
 assert.equal(auditAction({action:"verification.reviewed"},"ru"),"Обновил решение по заявке организатора");
 assert.equal(auditAction({action:"staff.login_failed"},"ru"),"Неудачная попытка входа");
 assert.equal(auditAction({action:"event.pause"},"en"),"Paused sales");
 assert.doesNotMatch(auditAction({action:"future.raw_action"},"ru"),/future|raw_action/);
});
test("audit details show readable changes while retaining technical history",()=>{
 const row={id:"audit-1",action:"support.updated",targetType:"case",targetId:"technical-case-id",staffId:"staff-1",relatedStaffNames:{"staff-1":"Игорь"},before:{status:"new",assignedStaffId:null},after:{status:"in_progress",assignedStaffId:"staff-1"}};
 assert.deepEqual(auditChanges(row,"ru"),[{key:"status",label:"Статус",before:"Новое",after:"В работе"},{key:"assignedStaffId",label:"Ответственный",before:"Не указано",after:"Игорь"}]);
 const html=renderToStaticMarkup(<LocaleProvider locale="ru"><AuditDetails row={row}/></LocaleProvider>);
 for(const text of ["Подробности","Было","Стало","Игорь","Технические данные","support.updated","technical-case-id"]) assert.ok(html.includes(text));
});
test("only approval renders the named public verified badge in all supported languages",()=>{
 for(const [locale,label] of [["ru","Проверенный организатор"],["kk","Расталған ұйымдастырушы"],["en","Verified organizer"]] as const){
  const render=(verified:boolean)=>renderToStaticMarkup(<LocaleProvider locale={locale}><VerifiedOrganizerBadge verified={verified}/></LocaleProvider>);
  assert.equal(render(false),"");assert.ok(render(true).includes(label));
 }
});
test("a complete application is labeled ready without awarding a public badge",()=>{
 const row:VerificationView={id:"id",version:1,status:"pending",caseId:"case",legalName:"Тестовая компания",entityType:"other",entityTypeDetails:"Некоммерческая организация",countryCode:"KZ",registrationId:"123",email:"owner@example.test",phone:"+77001234567",reviewReason:null,createdAt:"2026-11-16T00:00:00Z",documents:[{id:"10000000-0000-4000-8000-000000000001",name:"registration.pdf",mime:"application/pdf",size:123}]};
 const html=renderToStaticMarkup(<LocaleProvider locale="ru"><VerificationCard row={row} isLatest openCase={()=>{}} onChanged={()=>{}}/></LocaleProvider>);
 assert.match(html,/Данные заполнены/);assert.match(html,/Некоммерческая организация/);assert.match(html,/staff-api\/files/);assert.doesNotMatch(html,/role="img"/);
 const incomplete=renderToStaticMarkup(<LocaleProvider locale="ru"><VerificationCard row={{...row,countryCode:"",documents:[]}} isLatest openCase={()=>{}} onChanged={()=>{}}/></LocaleProvider>);
 assert.match(incomplete,/Данные неполные/);assert.match(incomplete,/disabled=""/);
});
