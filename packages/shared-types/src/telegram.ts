import type { EventLocale, PublicEvent } from "./events.js";
import type { CancellationTermsResponse } from "./booking.js";
import type { PublicVenueLayout } from "./venue.js";
import type { EventChatMessage, ManagementEventSummary, ManagementOrderDetail, ManagementOrderRow } from "./event-management.js";

export interface BotIdentityRequest {
  telegramId: string;
  chatId: string;
}

export interface BotIdentityResponse {
  user: { id: string; role: "guest" | "organizer" | "admin" };
}

export type BotEvent = PublicEvent;

export interface BotCity {
  city: string;
  countryCode: string | null;
}

export interface BotGuestSettings {
  locale: EventLocale | null;
  location: BotCity | null;
  linked: boolean;
  canOrganize: boolean;
}

export interface BotGuestSettingsUpdate {
  locale?: EventLocale;
  location?: BotCity | null;
}

export interface BotCatalogQuery {
  locale: EventLocale;
  page: number;
  search?: string;
  city?: string;
  countryCode?: string;
  category?: PublicEvent["category"];
  datePreset?: "today" | "weekend";
  free?: true;
}

export interface BotCheckoutSelection {
  kind: "ticket" | "table";
  itemId: string;
  locale: EventLocale;
}

export interface BotCheckoutQuote extends BotCheckoutSelection {
  eventId: string;
  title: string;
  itemName: string;
  timezone: string;
  amountDue: number;
  currency: string;
  refundTerms: string | null;
  refundsAvailable: boolean | null;
  policyRevision: number | null;
}

export interface BotCheckoutOffer extends BotCheckoutQuote {
  reference: string;
  expiresAt: string;
}

export interface BotPaymentStatus {
  orderId: string;
  status: "pending" | "paid" | "failed" | "cancelled" | "refunded" | "expired" | "review_required";
  title: string;
  timezone: string;
  amountDue: number;
  currency: string;
  expiresAt: string | null;
  paymentLink: string | null;
}

export type BotCheckoutResult = { order: BotPaymentStatus } | { offer: BotCheckoutOffer };

export type BotConversationSide = "guest" | "organizer";
export type BotConversationKind = "order" | "inquiry";
export interface BotConversationRef {
  side: BotConversationSide;
  kind: BotConversationKind;
  id: string;
}
export interface BotConversationSummary extends BotConversationRef {
  eventId: string;
  title: string;
  unread: number;
  closed: boolean;
}
export interface BotConversationPage {
  thread: BotConversationSummary;
  items: EventChatMessage[];
  nextCursor: string | null;
}
export interface BotConversationInbox { items: BotConversationSummary[]; hasNext: boolean }
export type BotOrganizerTab = "today" | "upcoming" | "past";
export interface BotOrganizerEvents {
  items: Array<{ id: string; title: string; date: string; time: string; timezone: string; status: string; published: boolean }>;
  hasNext: boolean;
}
export type BotOrganizerSnapshot = ManagementEventSummary & { publicCard: boolean };
export type BotOrganizerOrder = Pick<ManagementOrderRow, "id" | "createdAt" | "payment" | "resources" | "attendance"> & { buyerName: string | null };
export interface BotOrganizerOrderDetail extends BotOrganizerOrder {
  eventId: string;
  tickets: Array<Pick<ManagementOrderDetail["tickets"][number], "id" | "typeName" | "seatLabel" | "status"> & { canResend: boolean }>;
  hasNext: boolean;
}

export interface TelegramSeatSelection {
  seatIds: string[];
  tableId?: string;
}

export interface TelegramSeatItem {
  id: string;
  kind: "seat" | "table";
  label: string;
  amount: number;
  currency: string;
  available: boolean;
  capacity?: number;
}

export interface TelegramSeatQuote extends Omit<BotCheckoutQuote, "kind" | "itemId" | "itemName"> {
  kind: "cart";
  items: TelegramSeatItem[];
}

export interface TelegramSeatOffer extends TelegramSeatQuote {
  reference: string;
  expiresAt: string;
}

export interface TelegramSeatOrder extends BotPaymentStatus {
  demoPayment: boolean;
  chatUrl: string;
  serverTime: string;
  items: { label: string; amount: number }[];
  refundTerms: string | null;
  refundsAvailable: boolean | null;
}

export interface TelegramSeatCatalogue {
  event: Pick<PublicEvent, "id" | "title" | "date" | "time" | "timezone" | "address">;
  layout: PublicVenueLayout | null;
  groups: { label: string; items: TelegramSeatItem[] }[];
  closed: boolean;
}

export interface TelegramSeatSession {
  token: string;
  eventId: string;
  locale: EventLocale;
  chatUrl: string;
}

export type BotWalletTab = "upcoming" | "past" | "pending";
export type BotAdmissionKind = "ticket" | "group";
export type BotReturnKind = "ticket" | "booking";
export interface BotWalletEvent {
  id: string;
  title: string;
  startsAt: string;
  timezone: string;
  address: string;
  status: string;
}
export interface BotWalletAdmission {
  id: string;
  kind: BotAdmissionKind;
  name: string;
  seatLabel: string | null;
  status: string;
  qrAvailable: boolean;
  returnAvailable: boolean;
}
export interface BotWalletOrder {
  id: string;
  status: BotPaymentStatus["status"];
  amount: number | null;
  currency: string;
  anonymous: boolean;
  canClaim: boolean;
  cancellation: boolean;
  refund: "awaiting_review" | "requested" | "processing" | "succeeded" | "failed" | null;
}
export interface BotWalletList {
  items: BotWalletEvent[];
  hasNext: boolean;
  nextQr: Pick<BotWalletAdmission, "kind" | "id"> | null;
}
export interface BotWalletEventDay {
  event: BotWalletEvent;
  orders: BotWalletOrder[];
  hasNext: boolean;
  nextQr: BotWalletList["nextQr"];
  updates: string[];
}
export interface BotWalletOrderDetail {
  event: BotWalletEvent;
  order: BotWalletOrder;
  admissions: BotWalletAdmission[];
  booking: { id: string; label: string; status: string; returnAvailable: boolean } | null;
  hasNext: boolean;
}
export type BotReturnPreview = CancellationTermsResponse & { proof: string; label: string };

export interface BotOperationalPreview {
  id: string;
  eventId: string;
  type: import("./event-management.js").EventNotificationType;
  text: string;
  audienceCount: number;
  reachableCount: number;
  review: string;
}
export type BotOperationalResult = { preview: BotOperationalPreview } | {
  delivery: import("./event-management.js").EventNotificationStatus;
  eventId: string;
};
