import { z } from "zod";
import type { EventLocale } from "./events.js";
export type EventModerationAction = "approve" | "reject" | "hide" | "unhide" | "pause" | "resume" | "cancel";
export interface ModeratedEvent { status: string; moderationStatus?: string | undefined; approvedAt?: string | Date | null | undefined; salesPaused?: boolean | undefined; paymentMode?: string | undefined; }
export type EventReviewState = "pending" | "open" | "paused" | "rejected" | "hidden" | "cancelled" | "completed" | "archived" | "draft";
export function eventReviewState(event: ModeratedEvent): EventReviewState {
  if (event.status === "cancelled") return "cancelled";
  if (event.status === "completed") return event.moderationStatus === "expired" ? "archived" : "completed";
  if (event.moderationStatus === "hidden") return "hidden";
  if (event.moderationStatus === "pending") return "pending";
  if (event.moderationStatus === "rejected") return "rejected";
  if (event.status === "published" && event.approvedAt && ["approved", "sales_paused"].includes(event.moderationStatus ?? "")) return event.salesPaused || event.moderationStatus === "sales_paused" ? "paused" : "open";
  return event.status === "published" ? "pending" : "draft";
}
export const EVENT_REVIEW_LABELS: Record<EventLocale, Record<EventReviewState, string>> = {
  ru: { pending: "На модерации", open: "Опубликовано · продажи открыты", paused: "Опубликовано · продажи остановлены", rejected: "Не опубликовано · отклонено", hidden: "Скрыто", cancelled: "Отменено", completed: "Завершено", archived: "В архиве", draft: "Черновик" },
  kk: { pending: "Модерацияда", open: "Жарияланған · сатылым ашық", paused: "Жарияланған · сатылым тоқтатылған", rejected: "Жарияланбаған · қабылданбаған", hidden: "Жасырылған", cancelled: "Болдырылмаған", completed: "Аяқталған", archived: "Мұрағатта", draft: "Нобай" },
  en: { pending: "Pending moderation", open: "Published · sales open", paused: "Published · sales paused", rejected: "Unpublished · rejected", hidden: "Hidden", cancelled: "Cancelled", completed: "Completed", archived: "Archived", draft: "Draft" },
};
export function eventModerationActions(event: ModeratedEvent, role: string): EventModerationAction[] {
  const state = eventReviewState(event);
  if (["cancelled", "completed", "archived"].includes(state)) return [];
  const reviewable = state === "pending" || (state === "hidden" && !event.approvedAt);
  if (role === "support") return reviewable ? ["approve", "reject"] : [];
  if (role !== "moderator") return [];
  if (reviewable) return ["approve", "reject", "cancel"];
  if (state === "open") return ["hide", "pause", "cancel"];
  if (state === "paused") return event.paymentMode === "deposit" ? ["hide", "cancel"] : ["hide", "resume", "cancel"];
  if (state === "hidden" && event.approvedAt) return ["unhide", "cancel"];
  return state === "rejected" ? ["cancel"] : [];
}

export function eventModerationNotice(title: string, action: string, reason: string | null | undefined, locale: EventLocale): string {
  const outcomes: Record<EventLocale, Record<string, string>> = {
    ru: { approve: "одобрено", reject: "отклонено", hide: "скрыто", unhide: "снова доступно на сайте", pause: "продажи остановлены", resume: "продажи возобновлены", cancel: "отменено", review_required: "направлено на проверку; действующие билеты сохранены" },
    kk: { approve: "мақұлданды", reject: "қабылданбады", hide: "жасырылды", unhide: "сайтта қайта қолжетімді", pause: "сатылым тоқтатылды", resume: "сатылым жалғасты", cancel: "болдырылмады", review_required: "тексеруге жіберілді; қолданыстағы билеттер сақталды" },
    en: { approve: "approved", reject: "rejected", hide: "hidden", unhide: "visible again", pause: "sales paused", resume: "sales resumed", cancel: "cancelled", review_required: "submitted for review; existing tickets are preserved" },
  };
  const outcome = outcomes[locale][action];
  if (!outcome) return title;
  const prefix = locale === "ru" ? "Мероприятие" : locale === "kk" ? "Іс-шара" : "Event";
  const reasonLabel = locale === "ru" ? "Причина" : locale === "kk" ? "Себеп" : "Reason";
  return `${prefix} «${title}»: ${outcome}.${reason?.trim() ? ` ${reasonLabel}: ${reason.trim()}` : ""}`;
}

/** Existing legacy content may be corrected for review without rewriting sale resources. */
export const legacyReviewContentSchema = z.object({
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(20000),
  address: z.string().trim().min(1).max(250), date: z.iso.date(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1).max(64),
  program: z.string().max(20000).nullable().optional(), rules: z.string().max(20000).nullable().optional(),
  visitTerms: z.string().max(20000).nullable().optional(), cancellationTerms: z.string().max(20000).nullable().optional(), extraConditions: z.string().max(20000).nullable().optional(),
}).strict();
