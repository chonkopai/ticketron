import { verificationSchema, type VerificationView } from "./administration.js";
import type { EventLocale } from "./events.js";

/** Completeness is readiness for review, never an approval or a public badge. */
export function verificationReadiness(row: Pick<VerificationView, "legalName" | "entityType" | "entityTypeDetails" | "countryCode" | "registrationId" | "email" | "phone" | "documents">) {
  const result = verificationSchema.safeParse({legalName:row.legalName,entityType:row.entityType,...(row.entityTypeDetails ? {entityTypeDetails:row.entityTypeDetails} : {}),countryCode:row.countryCode,registrationId:row.registrationId,email:row.email,phone:row.phone,fileIds:row.documents.map(file=>file.id)});
  return {readyForReview:result.success,missingFields:result.success ? [] : [...new Set(result.error.issues.map(issue=>String(issue.path[0] ?? "application")))]};
}
export interface VerificationApplication extends VerificationView {
  organizerId: string;
  organizerName: string | null;
  readyForReview: boolean;
  missingFields: string[];
  isLatest?: boolean;
}
export function verificationDecisionNotice(name:string,decision:string,reason:string|null|undefined,locale:EventLocale):string {
  const outcomes:Record<EventLocale,Record<string,string>>={
    ru:{verified:"организатор подтверждён",rejected:"заявка отклонена",changes_requested:"нужно уточнить данные",revoked:"статус проверенного организатора отозван"},
    kk:{verified:"ұйымдастырушы расталды",rejected:"өтініш қабылданбады",changes_requested:"деректерді нақтылау қажет",revoked:"расталған ұйымдастырушы мәртебесі қайтарылды"},
    en:{verified:"organizer verified",rejected:"application rejected",changes_requested:"details need updating",revoked:"organizer verification revoked"},
  };
  const outcome=outcomes[locale][decision] ?? ({ru:"решение по заявке обновлено",kk:"өтініш шешімі жаңартылды",en:"application decision updated"})[locale];
  return `«${name}»: ${outcome}.${reason?.trim()?` ${{ru:"Причина",kk:"Себеп",en:"Reason"}[locale]}: ${reason.trim()}`:""}`;
}
