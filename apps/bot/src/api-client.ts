import type { AccountNotificationList, BotCatalogQuery, BotCheckoutOffer, BotCheckoutResult, BotCheckoutSelection, BotEvent, BotGuestSettings, BotGuestSettingsUpdate, BotIdentityResponse, BotPaymentStatus, EventLocale, PublicEventList, PublicEventSummary, PublicVenueLayout } from "@event-platform/shared-types";
import type { BotAdmissionKind, BotConversationSide, BotReturnKind, BotReturnPreview, BotWalletEventDay, BotWalletList, BotWalletOrderDetail, BotWalletTab, CancellationResponse } from "@event-platform/shared-types";

export class BotApiError extends Error {
  constructor(status: number, readonly code?: string) { super(`BOT_API_${status}`); }
}

export interface CheckoutActor { telegramId: string; chatId: string }

export interface BotApiClientOptions {
  apiBaseUrl: string;
  botApiSecret: string;
  fetch?: typeof globalThis.fetch | undefined;
}

export class BotApiClient {
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly options: BotApiClientOptions) { this.request = options.fetch ?? globalThis.fetch; }

  async catalogue(query: BotCatalogQuery): Promise<PublicEventList> {
    const params = new URLSearchParams({ limit: "6", sort: "recent" });
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    return this.json(`/events?${params}`);
  }

  async locations(): Promise<Array<{ countryCode: string; cities: string[] }>> { return this.json("/events/locations"); }

  async event(id: string, locale: EventLocale): Promise<BotEvent> { return this.json(`/events/${id}?locale=${locale}`); }

  async eventSummary(id: string, locale: EventLocale): Promise<PublicEventSummary | null> {
    return this.json(`/events/${id}/summary?locale=${locale}`);
  }

  async venueLayout(id: string, locale?: EventLocale): Promise<PublicVenueLayout | null> {
    return this.json<PublicVenueLayout | null>(`/events/${id}/venue-layout${locale ? `?locale=${locale}` : ""}`);
  }

  async grantWriteAccess(telegramId: number, chatId: number): Promise<void> {
    await this.json("/bot/write-access", { method: "POST", body: { telegramId: String(telegramId), chatId: String(chatId) } });
  }

  async guestSettings(actor: CheckoutActor): Promise<BotGuestSettings> {
    return this.json("/bot/guest/settings", { method: "POST", body: actor });
  }

  async updateGuestSettings(actor: CheckoutActor, changes: BotGuestSettingsUpdate): Promise<BotGuestSettings> {
    return this.json("/bot/guest/preferences", { method: "POST", body: { ...actor, ...changes } });
  }

  async messages(actor: CheckoutActor, locale: EventLocale, page: number): Promise<AccountNotificationList> {
    return this.json("/bot/guest/messages", { method: "POST", body: { ...actor, locale, page } });
  }

  companion<T>(actor: CheckoutActor, path: string, input?: object): Promise<T> {
    return this.json(`/bot/companion/${path}`, { method: "POST", body: { ...input, ...actor } });
  }

  async conversationAttachment(actor: CheckoutActor, side: BotConversationSide, id: string) {
    const response = await this.request(new URL(`/bot/companion/attachments/${id}`, this.options.apiBaseUrl), {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify({ ...actor, side }),
    });
    if (!response.ok) throw new BotApiError(response.status);
    const encoded = response.headers.get("content-disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return { bytes: new Uint8Array(await response.arrayBuffer()), name: encoded ? decodeURIComponent(encoded) : "Attachment" };
  }

  async identity(telegramId: number, chatId: number): Promise<BotIdentityResponse> {
    return this.json<BotIdentityResponse>("/bot/identity", { method: "POST", body: { telegramId: String(telegramId), chatId: String(chatId) } });
  }

  async checkoutOffer(actor: CheckoutActor, name: string, selection: BotCheckoutSelection): Promise<BotCheckoutOffer> {
    return this.json("/bot/checkout/offers", { method: "POST", body: { ...actor, ...selection, name } });
  }

  async confirmCheckout(actor: CheckoutActor, reference: string, messageId: number): Promise<BotCheckoutResult> {
    return this.json(`/bot/checkout/offers/${reference}/confirm`, { method: "POST", body: { ...actor, messageId } });
  }

  async checkoutOrders(actor: CheckoutActor, page: number): Promise<{ items: BotPaymentStatus[]; hasNext: boolean }> {
    return this.json("/bot/checkout/orders", { method: "POST", body: { ...actor, page } });
  }

  async checkoutOrder(actor: CheckoutActor, id: string, resume: boolean): Promise<BotPaymentStatus> {
    return this.json(`/bot/checkout/orders/${id}`, { method: "POST", body: { ...actor, resume } });
  }

  walletEvents(actor: CheckoutActor, locale: EventLocale, tab: BotWalletTab, page: number): Promise<BotWalletList> {
    return this.walletRequest("/events", actor, { locale, tab, page });
  }

  walletEvent(actor: CheckoutActor, locale: EventLocale, id: string, page: number): Promise<BotWalletEventDay> {
    return this.walletRequest(`/events/${id}`, actor, { locale, page });
  }

  walletOrder(actor: CheckoutActor, locale: EventLocale, id: string, page: number): Promise<BotWalletOrderDetail> {
    return this.walletRequest(`/orders/${id}`, actor, { locale, page });
  }

  walletReturn(actor: CheckoutActor, kind: BotReturnKind, id: string): Promise<BotReturnPreview> {
    return this.walletRequest(`/returns/${kind}/${id}`, actor);
  }

  walletConfirmReturn(actor: CheckoutActor, kind: BotReturnKind, id: string, proof: string): Promise<CancellationResponse> {
    return this.walletRequest(`/returns/${kind}/${id}/confirm`, actor, { proof });
  }

  walletClaim(actor: CheckoutActor, id: string): Promise<{ linked: boolean }> {
    return this.walletRequest(`/orders/${id}/claim`, actor);
  }

  async walletQr(actor: CheckoutActor, kind: BotAdmissionKind, id: string): Promise<Buffer> {
    const response = await this.request(new URL(`/bot/wallet/admission/${kind}/${id}`, this.options.apiBaseUrl), {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify(actor),
    });
    if (!response.ok) throw new BotApiError(response.status);
    return Buffer.from(await response.arrayBuffer());
  }

  private walletRequest<T>(path: string, actor: CheckoutActor, body: Record<string, unknown> = {}): Promise<T> {
    return this.json(`/bot/wallet${path}`, { method: "POST", body: { ...body, ...actor } });
  }

  private async json<T>(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { ...this.headers() };
    if (options.headers) Object.assign(headers, options.headers);
    if (options.body !== undefined) { headers["content-type"] = "application/json"; }
    const response = await this.request(new URL(path, this.options.apiBaseUrl), { method: options.method ?? "GET", headers, ...(options.body === undefined ? undefined : { body: JSON.stringify(options.body) }) });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { code?: string } | null;
      throw new BotApiError(response.status, error?.code);
    }
    return await response.json() as T;
  }

  private headers(): Record<string, string> {
    return { "x-bot-api-secret": this.options.botApiSecret };
  }
}

export function isPrivateChat(ctx: { chat: { type?: string } | undefined }): boolean { return ctx.chat?.type === "private"; }
