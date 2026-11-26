"use client";
import type { CurrencyCapability, EventLocale } from "@event-platform/shared-types";
import { ProtectedRoute } from "../../../(auth)/_components/protected-route";
import { ConnectedHallStudio, type StudioProps } from "../../../../components/hall-builder/connected-studio";

export interface DraftStudioOptions { currency: CurrencyCapability; locale: EventLocale; onFinish: () => Promise<void>; backHref: string }

/** The hall builder for an event. The previous ("classic") editor has been removed. */
export function Studio(props: StudioProps) {
  return <ConnectedHallStudio {...props} />;
}

export function HallStudio({ eventId }: { eventId: string }) {
  return <ProtectedRoute><Studio eventId={eventId} /></ProtectedRoute>;
}
