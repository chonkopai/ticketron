"use client";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { EventLocale } from "@event-platform/shared-types";
import { useLocale } from "../../../../components/locale-provider";
import { isLocale } from "../../../../lib/locale";

/** Old links to the standalone draft hall page open the hall picker on the create page. */
export function DraftHallPage() {
  const params = useSearchParams(), router = useRouter(), locale = useLocale(), id = params.get("draftId") ?? undefined;
  const contentLocale = isLocale(params.get("contentLocale")) ? params.get("contentLocale") as EventLocale : locale;
  useEffect(() => { if (id) router.replace(`/events/create?draftId=${id}&lang=${locale}&contentLocale=${contentLocale}&hall=choose`); }, [id, locale, contentLocale, router]);
  return <main className="tk-status-page"><section className="tk-status-card"><p className="tk-status-text" role={id ? "status" : "alert"}>{id ? <><span className="tk-status-spinner" aria-hidden="true" />…</> : "DRAFT_NOT_FOUND"}</p></section></main>;
}
