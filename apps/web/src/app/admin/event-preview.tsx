"use client";
import { useEffect, useRef, useState } from "react";
import type { PublicEvent, PublicVenueLayout } from "@event-platform/shared-types";
import PublicEventPage from "../events/[id]/event-client";
import { EventDescription } from "../../components/event-description";
import { ScaledEventPreview } from "../../components/event-creation/scaled-event-preview";
import { CurrencyProvider } from "../../components/currency-provider";
import { useLocale } from "../../components/locale-provider";
import { ResourceState, useResource, useText } from "./staff-ui";
export function StaffEventPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useText(), locale = useLocale(), ref = useRef<HTMLDialogElement>(null);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const resource = useResource<{ event: PublicEvent; layout: PublicVenueLayout | null }>(`events/${id}/preview?locale=${locale}`);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (window.matchMedia("(max-width: 640px)").matches) setDevice("phone");
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="staff-event-preview" aria-labelledby="staff-event-preview-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2 id="staff-event-preview-title">{t("Предпросмотр мероприятия", "Іс-шараны алдын ала қарау", "Event preview")}</h2><p>{t("Покупка билетов в предпросмотре недоступна", "Алдын ала қарауда билет сатып алу қолжетімсіз", "Purchases are disabled in preview")}</p></div>
      <div className="staff-preview-devices" role="group" aria-label={t("Размер экрана", "Экран өлшемі", "Screen size")}>
        <button aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}>{t("Компьютер", "Компьютер", "Desktop")}</button><button aria-pressed={device === "phone"} onClick={() => setDevice("phone")}>{t("Телефон", "Телефон", "Phone")}</button>
      </div><button onClick={onClose} aria-label={t("Закрыть предпросмотр", "Алдын ала қарауды жабу", "Close preview")}>×</button>
    </header>
    <div className="staff-event-preview-body"><ResourceState error={resource.error} loading={!resource.data} onRetry={resource.retry}/>
      {resource.data ? <ScaledEventPreview device={device} title={resource.data.event.title} locale={locale} onEscape={onClose}>
        <CurrencyProvider><PublicEventPage description={resource.data.event.description ? <EventDescription value={resource.data.event.description} /> : undefined} id={id} preview={{ ...resource.data, interactive: true, descriptionPlaceholder: "", emptyTickets: t("Билеты пока не добавлены", "Билеттер әлі қосылмаған", "No tickets added"), showRefund: true }}/></CurrencyProvider>
      </ScaledEventPreview> : null}
    </div>
  </dialog>;
}
