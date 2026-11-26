import { describe, expect, it } from "vitest";
import { eventModerationActions, eventModerationNotice, eventReviewState, EVENT_REVIEW_LABELS } from "./event-moderation.js";
import { moderateEventSchema } from "./administration.js";
const pending = { status: "draft", moderationStatus: "pending", approvedAt: null };
const approved = { status: "published", moderationStatus: "approved", approvedAt: "2026-11-16T00:00:00Z", salesPaused: false };
describe("event review policy", () => {
  it("never labels an unapproved publication as open", () => {
    expect(eventReviewState({status:"published", moderationStatus:"clear"})).toBe("pending");
    expect(eventReviewState({...approved, moderationStatus:"clear"})).toBe("pending");
    expect(eventReviewState(pending)).toBe("pending");
    expect(eventReviewState(approved)).toBe("open");
    expect(eventReviewState({...approved,moderationStatus:"sales_paused",salesPaused:true})).toBe("paused");
  });
  it("keeps rejected, hidden, draft and terminal states distinct", () => {
    for (const [event,state] of [[{...pending,moderationStatus:"rejected"},"rejected"],[{...approved,moderationStatus:"hidden"},"hidden"],[{status:"draft",moderationStatus:"clear"},"draft"],[{...pending,status:"cancelled"},"cancelled"],[{...pending,status:"completed"},"completed"]] as const) expect(eventReviewState(event)).toBe(state);
  });
  it("allows both staff levels to review without expanding support operational privileges", () => {
    expect(eventModerationActions(pending,"support")).toEqual(["approve","reject"]);
    expect(eventModerationActions(pending,"moderator")).toEqual(["approve","reject","cancel"]);
    expect(eventModerationActions(approved,"support")).toEqual([]);
    expect(eventModerationActions(approved,"moderator")).toEqual(["hide","pause","cancel"]);
    expect(eventModerationActions({...approved,status:"cancelled"},"moderator")).toEqual([]);
  });
  it("accepts omitted or blank reasons and rejects oversized reasons", () => {
    expect(moderateEventSchema.parse({action:"reject"}).reason).toBe("");
    expect(moderateEventSchema.parse({action:"approve",reason:"  "}).reason).toBe("");
    expect(moderateEventSchema.safeParse({action:"hide",reason:"x".repeat(501)}).success).toBe(false);
  });
  it("localizes notices without empty reason placeholders", () => {
    expect(eventModerationNotice("Концерт","reject","Уточните адрес","ru")).toContain("Причина: Уточните адрес");
    expect(eventModerationNotice("Concert","approve",null,"en")).toBe("Event «Concert»: approved.");
    expect(eventModerationNotice("Concert","reject","","kk")).toContain("қабылданбады");
    expect(EVENT_REVIEW_LABELS.ru.rejected).toBe("Не опубликовано · отклонено");
  });
});
