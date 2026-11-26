"use client";
import { EVENT_REVIEW_LABELS, eventReviewState, type ModeratedEvent } from "@event-platform/shared-types";
import "./event-review-status.css";
import { useLocale } from "./locale-provider";
export function EventReviewStatus({ event }: { event: ModeratedEvent }) {
  const locale = useLocale(), state = eventReviewState(event);
  return <span className={`event-review-status is-${state}`}>{EVENT_REVIEW_LABELS[locale][state]}</span>;
}
