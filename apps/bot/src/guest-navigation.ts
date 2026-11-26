import { updateCopy } from "./update-copy.js";
import { randomBytes } from "node:crypto";
import { EVENT_CATEGORIES, cityAliases, hasEventEnded, localizedCityName, type BotCatalogQuery, type BotCity, type EventCategory, type PublicEvent } from "@event-platform/shared-types";
import { InlineKeyboard } from "grammy";
import { BotApiClient, BotApiError } from "./api-client.js";
import { checkoutReference } from "./checkout.js";
import { companionCopy } from "./companion-copy.js";
import { categoryLabels, guestCopy, guestLocale, type GuestContext } from "./guest-copy.js";
import { catalogueEvent, cataloguePrice, eventText, truncate } from "./presentation.js";
import { HTML, bold, esc } from "./format.js";

type Filters = Omit<BotCatalogQuery, "locale" | "city" | "countryCode"> & { location: BotCity | null };
type Screen =
  | { kind: "catalogue"; filters: Filters }
  | { kind: "cities"; filters: Filters | null; choices: BotCity[]; page: number }
  | { kind: "event"; id: string; filters: Filters | null }
  | { kind: "search"; filters: Filters };

const PAGE_LIMIT = 1000;
const CITY_PAGE_SIZE = 8;
const OPTION_PAGE_SIZE = 6;
const SESSION_TTL = 45 * 60_000;
const SESSION_LIMIT = 4096;
const eventReference = new RegExp(`^${checkoutReference}$`);
const navReference = /^n:([A-Za-z0-9_-]{12}):([^:]+)(?::([^:]+))?$/;
const languageLabels = { ru: "Русский", kk: "Қазақша", en: "English" };

interface GuestNavigationOptions { username: string; webOrigin?: string; messagesEnabled?: boolean; seatMiniAppName?: string; }

export class GuestNavigation {
  private readonly sessions = new Map<string, { owner: string; expiresAt: number; screen: Screen }>();

  constructor(private readonly options: GuestNavigationOptions) {}

  async load(ctx: GuestContext, api: BotApiClient): Promise<void> {
    const recipient = actor(ctx);
    if (!recipient || ctx.guestSettings) return;
    ctx.guestSettings = await api.guestSettings(recipient).catch(() => ({ locale: null, location: null, linked: false, canOrganize: false }));
  }

  async home(ctx: GuestContext, api: BotApiClient): Promise<void> {
    await this.load(ctx, api);
    const copy = guestCopy[guestLocale(ctx)];
    const keyboard = new InlineKeyboard().text(copy.find, "guest:find").row().text(copy.tickets, "checkout:tickets");
    if (this.options.messagesEnabled !== false) keyboard.text(copy.messages, "guest:messages:1");
    keyboard.row().text(copy.profile, "guest:profile");
    if (ctx.guestSettings?.canOrganize) keyboard.text(copy.organizer, "guest:organizer");
    const name = ctx.from?.first_name?.trim();
    await panel(ctx, `👋 <b>${esc(copy.hello)}${name ? `, ${esc(truncate(name, 40))}` : ""}!</b>\n\n${copy.welcome}\n\n${copy.welcomeAsk}`, keyboard);
  }

  async discovery(ctx: GuestContext, api: BotApiClient, query?: string): Promise<void> {
    await this.load(ctx, api);
    const filters: Filters = { page: 1, location: ctx.guestSettings?.location ?? null };
    if (query === "") await this.searchPrompt(ctx, filters);
    else await this.catalogue(ctx, api, { ...filters, ...(query ? { search: query } : {}) });
  }

  async sharedEvent(ctx: GuestContext, api: BotApiClient, id: string): Promise<void> {
    await this.load(ctx, api);
    await this.eventCard(ctx, api, { kind: "event", id, filters: null });
  }

  async replySearch(ctx: GuestContext, api: BotApiClient): Promise<boolean> {
    const message = ctx.message;
    if (!message?.text || message.text.startsWith("/") || !message.reply_to_message) return false;
    const prompt = this.session(ctx, `reply-${owner(ctx)}-${message.reply_to_message.message_id}`);
    if (prompt?.kind !== "search") return false;
    await this.load(ctx, api);
    const search = message.text.trim().replace(/\s+/g, " ");
    if (search.length > 120) { await this.searchPrompt(ctx, prompt.filters, guestCopy[guestLocale(ctx)].searchLong); return true; }
    if (search) await this.catalogue(ctx, api, { ...prompt.filters, search, page: 1 });
    return true;
  }

  async callback(ctx: GuestContext, api: BotApiClient, data: string): Promise<boolean> {
    const navigation = navReference.exec(data);
    if (!navigation && !data.startsWith("guest:")) return false;
    await this.load(ctx, api);
    const copy = guestCopy[guestLocale(ctx)];
    try {
      if (data === "guest:home") await this.home(ctx, api);
      else if (data === "guest:find") await this.discovery(ctx, api);
      else if (data === "guest:profile") await this.profile(ctx);
      else if (/^guest:alerts:[1-9]\d{0,2}$/.test(data)) {
        if (this.options.messagesEnabled !== false) await this.messages(ctx, api, Number(data.split(":")[2]));
        else await this.home(ctx, api);
      } else if (data.startsWith("guest:messages:")) await this.home(ctx, api);
      else if (data === "guest:language") await this.languages(ctx);
      else if (data === "guest:city") {
        if (await this.allowPrivate(ctx)) await this.cities(ctx, api, null);
      } else if (/^guest:lang:(ru|en|kk)$/.test(data)) {
        if (await this.allowPrivate(ctx)) {
          const value = data.split(":")[2] as keyof typeof languageLabels;
          ctx.guestSettings = await api.updateGuestSettings(actor(ctx)!, { locale: value });
          await this.profile(ctx);
        }
      } else if (navigation) {
        const [, key, action, value] = navigation;
        const screen = this.session(ctx, key!);
        if (!screen) { await panel(ctx, copy.expired, new InlineKeyboard().text(copy.find, "guest:find").text(copy.home, "guest:home")); return true; }
        if (screen.kind === "catalogue") await this.catalogueAction(ctx, api, screen.filters, key!, action!, value);
        if (screen.kind === "cities") await this.cityAction(ctx, api, screen, action!, value);
        if (screen.kind === "event") await this.eventAction(ctx, api, screen, key!, action!, value);
      }
    } catch { await panel(ctx, copy.unavailable, this.homeButton(ctx)); }
    return true;
  }

  private async catalogue(ctx: GuestContext, api: BotApiClient, filters: Filters): Promise<void> {
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    const { location, ...query } = filters;
    const key = this.put(ctx, { kind: "catalogue", filters });
    const keyboard = new InlineKeyboard();
    const locationLabel = location ? localizedCityName(location.city, locale, location.countryCode ?? undefined) : copy.allCities;
    let text: string;
    try {
      const result = await api.catalogue({ ...query, locale, ...(location ? { city: location.city, ...(location.countryCode ? { countryCode: location.countryCode } : {}) } : {}) });
      const tags = [locationLabel, filters.datePreset ? copy[filters.datePreset] : "",
        filters.category ? categoryLabels[locale][filters.category] : "", filters.free ? copy.free : "", filters.search ? `“${filters.search}”` : ""].filter(Boolean);
      const list = result.items.map((event, index) => {
        keyboard.text(truncate(`${index + 1}. ${event.title}`, 55), `n:${key}:event:${event.id}`).row();
        return catalogueEvent(event, locale, false, undefined, index + 1);
      });
      text = [`<b>${copy.catalogue}</b>\n<i>${esc(tags.join(" · "))}</i>`, ...(list.length ? list : [copy.empty])].join("\n\n");
      addPagination(keyboard, copy, `n:${key}:page`, filters.page, result.hasNext && filters.page < PAGE_LIMIT);
    } catch {
      text = copy.unavailable;
      keyboard.text(copy.find, `n:${key}:page:${filters.page}`).row();
    }
    keyboard.text(copy.search, `n:${key}:search`).text(copy.city, `n:${key}:cities`).text(copy.category, `n:${key}:categories`).row()
      .text(toggle(copy.today, filters.datePreset === "today"), `n:${key}:date:today`)
      .text(toggle(copy.weekend, filters.datePreset === "weekend"), `n:${key}:date:weekend`)
      .text(toggle(copy.free, filters.free), `n:${key}:free`).row();
    if (filters.search) keyboard.text(copy.clearSearch, `n:${key}:clear`);
    if (filters.search || filters.datePreset || filters.free || filters.category || location) keyboard.text(copy.reset, `n:${key}:reset`);
    keyboard.row().text(copy.home, "guest:home");
    await panel(ctx, text, keyboard);
  }

  private async catalogueAction(ctx: GuestContext, api: BotApiClient, filters: Filters, key: string, action: string, value?: string): Promise<void> {
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    if (action === "event" && value && eventReference.test(value)) {
      await this.eventCard(ctx, api, { kind: "event", id: value, filters });
    } else if (action === "search") {
      await this.searchPrompt(ctx, filters);
    } else if (action === "cities") {
      await this.cities(ctx, api, filters);
    } else if (action === "categories") {
      const keyboard = new InlineKeyboard().text(copy.allCategories, `n:${key}:category:all`).row();
      EVENT_CATEGORIES.forEach((category, index) => {
        keyboard.text(toggle(categoryLabels[locale][category], category === filters.category), `n:${key}:category:${category}`);
        if (index % 2 === 1) keyboard.row();
      });
      keyboard.row().text(copy.back, `n:${key}:page:${filters.page}`).text(copy.home, "guest:home");
      await panel(ctx, `<b>${copy.category}</b>`, keyboard);
    } else if (action === "page" && validPage(value)) {
      await this.catalogue(ctx, api, { ...filters, page: Number(value) });
    } else if (action === "reset") {
      await this.catalogue(ctx, api, { location: null, page: 1 });
    } else {
      const next = { ...filters, page: 1 };
      if (action === "date" && (value === "today" || value === "weekend")) {
        if (value === filters.datePreset) delete next.datePreset;
        else next.datePreset = value;
      } else if (action === "free") {
        if (next.free) delete next.free;
        else next.free = true;
      } else if (action === "clear") {
        delete next.search;
      } else if (action === "category") {
        if (value === "all") delete next.category;
        else if (EVENT_CATEGORIES.some(category => category === value)) next.category = value as EventCategory;
        else return;
      } else return;
      await this.catalogue(ctx, api, next);
    }
  }

  private async searchPrompt(ctx: GuestContext, filters: Filters, warning?: string): Promise<void> {
    const copy = guestCopy[guestLocale(ctx)];
    const sent = await ctx.reply([warning, copy.searchPrompt].filter(Boolean).join("\n"), {
      reply_markup: { force_reply: true, ...(ctx.message ? { selective: true } : {}) },
      ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
    });
    this.put(ctx, { kind: "search", filters }, `reply-${owner(ctx)}-${sent.message_id}`);
  }

  private async cities(ctx: GuestContext, api: BotApiClient, filters: Filters | null): Promise<void> {
    const locale = guestLocale(ctx);
    const cities = (await api.locations()).flatMap(group => {
      const unique = new Map<string, BotCity>();
      for (const city of group.cities) {
        const canonical = cityAliases(city, group.countryCode)[0] ?? city;
        unique.set(canonical.toLocaleLowerCase(), { city: canonical, countryCode: group.countryCode });
      }
      return [...unique.values()];
    });
    cities.sort((a, b) => localizedCityName(a.city, locale, a.countryCode ?? undefined).localeCompare(localizedCityName(b.city, locale, b.countryCode ?? undefined), locale));
    await this.cityPanel(ctx, { kind: "cities", choices: cities, page: 1, filters });
  }

  private async cityPanel(ctx: GuestContext, screen: Extract<Screen, { kind: "cities" }>): Promise<void> {
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    const key = this.put(ctx, screen);
    const from = (screen.page - 1) * CITY_PAGE_SIZE;
    const keyboard = new InlineKeyboard().text(copy.allCities, `n:${key}:select:all`).row();
    screen.choices.slice(from, from + CITY_PAGE_SIZE).forEach((item, index) =>
      keyboard.text(truncate(cityLabel(item, locale), 50), `n:${key}:select:${from + index}`).row());
    addPagination(keyboard, copy, `n:${key}:cities`, screen.page, from + CITY_PAGE_SIZE < screen.choices.length && screen.page < PAGE_LIMIT);
    keyboard.text(copy.back, screen.filters ? `n:${key}:back` : "guest:profile").text(copy.home, "guest:home");
    await panel(ctx, screen.filters ? copy.selectCity : copy.selectDefaultCity, keyboard);
  }

  private async cityAction(ctx: GuestContext, api: BotApiClient, screen: Extract<Screen, { kind: "cities" }>, action: string, value?: string): Promise<void> {
    if (action === "cities" && validPage(value)) {
      await this.cityPanel(ctx, { ...screen, page: Number(value) });
    } else if (action === "back" && screen.filters) {
      await this.catalogue(ctx, api, screen.filters);
    } else if (action === "select") {
      const selected = value === "all" ? null : value && /^\d+$/.test(value) ? screen.choices[Number(value)] : undefined;
      if (selected === undefined) return;
      if (screen.filters) await this.catalogue(ctx, api, { ...screen.filters, location: selected, page: 1 });
      else if (await this.allowPrivate(ctx)) {
        ctx.guestSettings = await api.updateGuestSettings(actor(ctx)!, { location: selected });
        await this.profile(ctx);
      }
    }
  }

  private async eventCard(ctx: GuestContext, api: BotApiClient, screen: Extract<Screen, { kind: "event" }>, key = this.put(ctx, screen)): Promise<void> {
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    const keyboard = new InlineKeyboard();
    try {
      const [event, summary] = await Promise.all([api.event(screen.id, locale), api.eventSummary(screen.id, locale)]);
      if (!summary) { await this.eventUnavailable(ctx, key); return; }
      const ended = hasEventEnded(event), paused = event.salesPaused || event.paymentMode === "deposit";
      const closed = ended || paused;
      if (!closed && ["available", "few_left"].includes(summary.saleStatus)) keyboard.text(copy.buy, `n:${key}:buy:1`).row();
      const share = new URL("https://t.me/share/url");
      share.searchParams.set("url", `https://t.me/${this.options.username}?start=e_${event.id}`);
      share.searchParams.set("text", truncate(event.title, 200));
      const directions = new URL("https://www.google.com/maps/search/");
      directions.searchParams.set("api", "1");
      directions.searchParams.set("query", `${event.address}, ${event.city}`);
      keyboard.text(copy.details, `n:${key}:details:1`).url(copy.directions, directions.href).row().url(copy.share, share.href);
      if (this.options.messagesEnabled !== false) keyboard.text(companionCopy[locale].ask, `c:n:${event.id}`);
      keyboard.row();
      this.eventBack(ctx, keyboard, key, screen);
      const caption = catalogueEvent(summary, locale, true, ended ? "ended" : paused ? "paused" : undefined);
      const image = mediaUrl(event.posterUrl ?? summary.posterUrl, this.options.webOrigin);
      if (image) {
        try { await ctx.replyWithPhoto(image, { caption, reply_markup: keyboard, ...HTML }); return; }
        catch { /* A missing or rejected public image falls back to the same card in text. */ }
      }
      await panel(ctx, caption, keyboard);
    } catch (error) {
      if (error instanceof BotApiError && error.message === "BOT_API_404") await this.eventUnavailable(ctx, key);
      else await panel(ctx, copy.unavailable, new InlineKeyboard().text(copy.back, screen.filters ? `n:${key}:back` : "guest:find").text(copy.home, "guest:home"));
    }
  }

  private async eventAction(ctx: GuestContext, api: BotApiClient, screen: Extract<Screen, { kind: "event" }>, key: string, action: string, value?: string): Promise<void> {
    if (action === "open") { await this.eventCard(ctx, api, screen, key); return; }
    if (action === "back") {
      if (screen.filters) await this.catalogue(ctx, api, screen.filters);
      else await this.discovery(ctx, api);
      return;
    }
    if ((action !== "details" && action !== "buy") || !validPage(value)) return;
    const copy = guestCopy[guestLocale(ctx)];
    try {
      const event = await api.event(screen.id, guestLocale(ctx)), page = Number(value);
      const keyboard = new InlineKeyboard().text(copy.back, `n:${key}:open`).text(copy.home, "guest:home");
      if (action === "details") {
        const description = [event.description, event.program, event.rules, event.visitTerms, event.cancellationTerms, event.extraConditions]
          .filter((part): part is string => !!part).map(eventText).join("\n\n");
        const pages = description.match(/[\s\S]{1,1700}/gu) ?? [copy.noDetails];
        const buttons = new InlineKeyboard();
        addPagination(buttons, copy, `n:${key}:details`, page, page < pages.length);
        buttons.append(keyboard);
        await panel(ctx, `${bold(truncate(event.title, 150))}\n\n${esc(pages[page - 1] ?? copy.noDetails)}`, buttons);
      } else {
        await this.buyOptions(ctx, api, event, key, page);
      }
    } catch (error) {
      if (error instanceof BotApiError && error.message === "BOT_API_404") await this.eventUnavailable(ctx, key);
      else await panel(ctx, copy.unavailable, this.homeButton(ctx));
    }
  }

  private async buyOptions(ctx: GuestContext, api: BotApiClient, event: PublicEvent, key: string, page: number): Promise<void> {
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    const keyboard = new InlineKeyboard();
    const closed = event.salesPaused || event.paymentMode === "deposit" || hasEventEnded(event);
    let hasMap = false;
    if (!closed && (this.options.seatMiniAppName || this.options.webOrigin)) {
      const layout = await api.venueLayout(event.id, locale).catch(() => null);
      if (layout && this.options.seatMiniAppName && (layout.rows.length || layout.tables.length || layout.seats?.length)) {
        const launch = new URL(`https://t.me/${this.options.username}/${this.options.seatMiniAppName}`);
        launch.searchParams.set("startapp", `s_${event.id}`);
        keyboard.url(copy.seats, launch.href).row();
        hasMap = true;
      } else if (this.options.webOrigin && layout?.seats?.some(seat => seat.status === "available")) {
        keyboard.url(copy.seats, new URL(`/events/${event.id}#venue-plan`, this.options.webOrigin).href).row();
        hasMap = true;
      }
    }
    const options = closed ? [] : [
      ...event.ticketTypes.filter(item => item.status === "active" && item.remaining > 0).map(item => ({ ...item, kind: "ticket" })),
      ...event.tables.filter(item => item.saleMode === "whole_table" && item.availability === "available").map(item => ({ ...item, kind: "table", name: item.name ?? `${copy.table} №${item.number}` })),
    ];
    const start = (page - 1) * OPTION_PAGE_SIZE;
    for (const item of options.slice(start, start + OPTION_PAGE_SIZE)) {
      keyboard.text(`${truncate(item.name || copy[item.kind === "ticket" ? "ticket" : "table"], 34)} · ${cataloguePrice(item.payment.amountDue, item.payment.currency, locale)}`, `buy:${item.kind}:${item.id}:${key}`).row();
    }
    addPagination(keyboard, copy, `n:${key}:buy`, page, start + OPTION_PAGE_SIZE < options.length && page < PAGE_LIMIT);
    keyboard.text(copy.back, `n:${key}:open`).text(copy.home, "guest:home");
    await panel(ctx, [bold(truncate(event.title, 150)), options.length || hasMap ? copy.choose : event.salesPaused ? `⏸ ${copy.paused}` : copy.unavailableOptions].join("\n\n"), keyboard);
  }

  private async profile(ctx: GuestContext): Promise<void> {
    if (!await this.allowPrivate(ctx)) return;
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    const keyboard = new InlineKeyboard().text(copy.language, "guest:language").text(copy.city, "guest:city").row();
    if (ctx.guestSettings?.linked) keyboard.text(updateCopy[locale].preferences, "u:p").row();
    this.accountLinks(ctx, keyboard);
    keyboard.text(copy.home, "guest:home");
    const city = ctx.guestSettings?.location;
    const text = [`<b>${copy.profile}</b>\n`, `${copy.languageLine}: ${languageLabels[locale]}`, `${copy.cityLine}: ${esc(city ? cityLabel(city, locale) : copy.allCities)}`];
    await panel(ctx, text.join("\n"), keyboard);
  }

  private async languages(ctx: GuestContext): Promise<void> {
    if (!await this.allowPrivate(ctx)) return;
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    const keyboard = new InlineKeyboard();
    for (const [value, label] of Object.entries(languageLabels)) keyboard.text(toggle(label, value === locale), `guest:lang:${value}`);
    keyboard.row().text(copy.back, "guest:profile").text(copy.home, "guest:home");
    await panel(ctx, copy.selectLanguage, keyboard);
  }

  private async messages(ctx: GuestContext, api: BotApiClient, page: number): Promise<void> {
    if (!await this.allowPrivate(ctx)) return;
    const locale = guestLocale(ctx), copy = guestCopy[locale];
    const keyboard = new InlineKeyboard();
    const recipient = actor(ctx)!;
    let text = this.options.webOrigin && !ctx.guestSettings?.linked ? copy.linkHint : copy.inboxEmpty;
    if (ctx.guestSettings?.linked) {
      const messages = await api.messages(recipient, locale, page);
      const labels = updateCopy[locale];
      if (messages.items.length) {
        text = [`${copy.unread}: <b>${messages.unreadCount}</b>`, ...messages.items.map((item, index) => `${item.readAt ? "▫️" : "🔵"} <b>${index + 1}.</b> ${esc(truncate(item.text, 450))}`)].join("\n\n");
        for (const [index, item] of messages.items.entries()) {
          if (item.orderId) keyboard.text(`${index + 1} · ${labels.order}`, `w:o:${item.orderId}:1`);
          else if (item.eventId) keyboard.text(`${index + 1} · ${labels.event}`, item.type === "event.reminder" || item.type === "event.cancellation" ? `w:e:${item.eventId}:1` : `event:${item.eventId}`);
          if (!item.readAt && item.id) keyboard.text(`${index + 1} · ${labels.read}`, `u:m:${item.id}:${page}`);
          if (item.orderId || item.eventId || (!item.readAt && item.id)) keyboard.row();
        }
      }
      addPagination(keyboard, copy, "guest:alerts", page, messages.hasNext && page < 999);
      if (this.options.webOrigin) keyboard.url(copy.inboxInfo, new URL("/account?tab=notifications", this.options.webOrigin).href).row();
    }
    if (ctx.guestSettings?.linked) keyboard.text(updateCopy[locale].preferences, "u:p").row();
    this.accountLinks(ctx, keyboard);
    keyboard.text(copy.back, "guest:messages:1").text(copy.home, "guest:home");
    await panel(ctx, `<b>${companionCopy[locale].alerts}</b>\n\n${text}`, keyboard);
  }

  private accountLinks(ctx: GuestContext, keyboard: InlineKeyboard): void {
    if (!this.options.webOrigin) return;
    const copy = guestCopy[guestLocale(ctx)];
    keyboard.url(ctx.guestSettings?.linked ? copy.account : copy.linkAccount, new URL("/account?tab=profile", this.options.webOrigin).href)
      .url(copy.support, new URL("/account?tab=support", this.options.webOrigin).href).row();
  }

  private async allowPrivate(ctx: GuestContext): Promise<boolean> {
    if (actor(ctx)) return true;
    await panel(ctx, guestCopy[guestLocale(ctx)].private, this.homeButton(ctx));
    return false;
  }

  private async eventUnavailable(ctx: GuestContext, key: string): Promise<void> {
    const copy = guestCopy[guestLocale(ctx)];
    await panel(ctx, copy.eventGone, new InlineKeyboard().text(copy.find, `n:${key}:back`).text(copy.home, "guest:home"));
  }

  private eventBack(ctx: GuestContext, keyboard: InlineKeyboard, key: string, screen: Extract<Screen, { kind: "event" }>) {
    const copy = guestCopy[guestLocale(ctx)];
    keyboard.text(screen.filters ? copy.back : copy.find, `n:${key}:back`).text(copy.home, "guest:home");
  }

  private homeButton(ctx: GuestContext) { return new InlineKeyboard().text(guestCopy[guestLocale(ctx)].home, "guest:home"); }

  private put(ctx: GuestContext, screen: Screen, key = randomBytes(9).toString("base64url")): string {
    if (this.sessions.size >= SESSION_LIMIT) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(key, { owner: owner(ctx), expiresAt: Date.now() + SESSION_TTL, screen });
    return key;
  }

  private session(ctx: GuestContext, key: string): Screen | undefined {
    const session = this.sessions.get(key);
    return session && session.owner === owner(ctx) && session.expiresAt > Date.now() ? session.screen : undefined;
  }
}

function actor(ctx: GuestContext) {
  return ctx.chat?.type === "private" && ctx.from?.id === ctx.chat.id
    ? { telegramId: String(ctx.from.id), chatId: String(ctx.chat.id) } : null;
}
function owner(ctx: GuestContext) { return `${ctx.chat?.id}:${ctx.from?.id}`; }
function toggle(text: string, active?: boolean) { return active ? `✅ ${text}` : text; }
function validPage(value?: string): boolean { return !!value && /^(?:[1-9]\d{0,2}|1000)$/.test(value); }
function cityLabel(city: BotCity, locale: keyof typeof guestCopy) {
  const name = localizedCityName(city.city, locale, city.countryCode ?? undefined);
  return city.countryCode ? `${name} · ${city.countryCode}` : name;
}

function addPagination(keyboard: InlineKeyboard, copy: { previous: string; next: string }, prefix: string, page: number, hasNext: boolean): void {
  if (page > 1) keyboard.text(copy.previous, `${prefix}:${page - 1}`);
  if (hasNext) keyboard.text(copy.next, `${prefix}:${page + 1}`);
  if (page > 1 || hasNext) keyboard.row();
}

async function panel(ctx: GuestContext, text: string, keyboard: InlineKeyboard): Promise<void> {
  const options = { reply_markup: keyboard, link_preview_options: { is_disabled: true }, ...HTML };
  const origin = ctx.callbackQuery?.message;
  if (origin && "text" in origin && origin.text) {
    try { await ctx.editMessageText(text, options); return; }
    catch (error) { if (error instanceof Error && error.message.includes("message is not modified")) return; }
  }
  await ctx.reply(text, options);
}

function mediaUrl(poster: string | null, webOrigin?: string): string | null {
  if (!poster || poster.startsWith("//")) return null;
  try {
    const url = new URL(poster, webOrigin);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
