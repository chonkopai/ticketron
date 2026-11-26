import { Bot, Context, InlineKeyboard } from "grammy";

import { BotApiClient, isPrivateChat } from "./api-client.js";
import { buyFromChat, checkoutCallback, checkoutReference, showCheckoutOrder, showCheckoutOrders } from "./checkout.js";
import { GuestNavigation } from "./guest-navigation.js";
import { guestCopy, guestLocale } from "./guest-copy.js";
import { createLinkCallbackHandler, createStartHandler, type StartHandlerOptions } from "./handlers/start.js";
import { helpText, type BotRole } from "./presentation.js";
import { HTML } from "./format.js";
import { TicketWallet } from "./wallet.js";
import { BotCompanion } from "./companion.js";

// Verification delivery needs Telegram's actual message_id. Webhook replies hide API results.
export const BOT_CLIENT_OPTIONS = { canUseWebhookReply: (_method: string): boolean => false };

interface BotOptions extends StartHandlerOptions { webOrigin?: string; messagesEnabled?: boolean; seatMiniAppName?: string; }
const SEARCH_MAX_LENGTH = 120;
const buyPattern = new RegExp(`^buy:(ticket|table):(${checkoutReference})(?::([A-Za-z0-9_-]{12}))?$`);
const eventPattern = new RegExp(`^event:(${checkoutReference})$`);

export function createBot(token: string, username: string, options: BotOptions): Bot {
  const tokenBotId = Number.parseInt(token.split(":")[0] ?? "0", 10);
  const bot = new Bot(token, {
    botInfo: { id: Number.isSafeInteger(tokenBotId) ? tokenBotId : 0, is_bot: true, first_name: "Event Platform", username, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
    client: BOT_CLIENT_OPTIONS,
  });

  const api = (): BotApiClient => new BotApiClient({ apiBaseUrl: options.apiBaseUrl, botApiSecret: options.botApiSecret, fetch: options.fetch });
  const navigation = new GuestNavigation({ ...options, username });
  const wallet = new TicketWallet(options.webOrigin, options.messagesEnabled);
  const companion = new BotCompanion(options.botApiSecret, options.webOrigin, options.messagesEnabled);
  const dashboard = async (ctx: Context, action: string, client = api()) => {
    await navigation.load(ctx, client);
    await companion.callback(ctx, client, action);
  };

  const linkCallback = createLinkCallbackHandler(options);

  bot.on("message:write_access_allowed", async ctx => {
    if (isPrivateChat(ctx) && ctx.from) await api().grantWriteAccess(ctx.from.id, ctx.chat.id);
  });

  bot.command("start", createStartHandler({
    ...options,
    showHome: (ctx) => navigation.home(ctx, api()),
    openEvent: (ctx, eventId) => navigation.sharedEvent(ctx, api(), eventId),
    openEventDay: async (ctx, eventId) => { const client = api(); await navigation.load(ctx, client); await wallet.eventDay(ctx, client, eventId); },
    openOrder: async (ctx, orderId) => { const client = api(); await navigation.load(ctx, client); await showCheckoutOrder(ctx, client, orderId); },
    openConversation: async (ctx, payload) => { const client = api(); await navigation.load(ctx, client); await companion.openLink(ctx, client, payload); },
  }));
  bot.command("menu", (ctx) => navigation.home(ctx, api()));
  bot.command("help", async (ctx) => {
    const client = api();
    await navigation.load(ctx, client);
    const copy = guestCopy[guestLocale(ctx)];
    const keyboard = new InlineKeyboard().text(copy.find, "guest:find").text(copy.tickets, "checkout:tickets").row().text(copy.home, "guest:home");
    await ctx.reply(helpText(await roleForContext(ctx, client), guestLocale(ctx)), { reply_markup: keyboard, ...HTML });
  });
  bot.command("events", (ctx) => navigation.discovery(ctx, api()));
  bot.command("search", async (ctx) => {
    const query = parseSearchQuery(ctx.message?.text);
    const client = api();
    await navigation.load(ctx, client);
    if (query.length > SEARCH_MAX_LENGTH) { await ctx.reply(guestCopy[guestLocale(ctx)].searchLong); return; }
    await navigation.discovery(ctx, client, query);
  });
  bot.command(["tickets", "my_tickets"], async (ctx) => { const client = api(); await navigation.load(ctx, client); await wallet.show(ctx, client); });
  bot.command("today", (ctx) => dashboard(ctx, "a:e:today:1"));
  bot.command("notify", (ctx) => dashboard(ctx, "a:u:upcoming:1"));
  bot.command("chat", (ctx) => options.messagesEnabled === false ? navigation.home(ctx, api()) : dashboard(ctx, "c:l:g:1"));
  bot.command("check_payment", async (ctx) => { const client = api(); await navigation.load(ctx, client); await showCheckoutOrders(ctx, client); });
  bot.on("message:text", async (ctx) => {
    if (!isPrivateChat(ctx) || ctx.message.text.startsWith("/")) return;
    const client = api();
    await navigation.load(ctx, client);
    if (await companion.reply(ctx, client)) return;
    if (await navigation.replySearch(ctx, client)) return;
    await navigation.home(ctx, client);
  });

  bot.on("callback_query:data", async (ctx) => {
    // Telegram requires an acknowledgement quickly, before any database/API work.
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    if (await linkCallback(ctx, data)) return;
    const client = api();
    if (data === "guest:organizer") { await dashboard(ctx, "a:h", client); return; }
    if (data.startsWith("guest:messages:") && options.messagesEnabled !== false) {
      await dashboard(ctx, `c:l:g:${data.split(":")[2]}`, client);
      return;
    }
    if (data.startsWith("c:") || data.startsWith("a:") || data.startsWith("u:")) { await dashboard(ctx, data, client); return; }
    if (await navigation.callback(ctx, client, data)) return;
    if (data.startsWith("events:")) { await navigation.discovery(ctx, client); return; }
    const eventMatch = eventPattern.exec(data);
    if (eventMatch) { await navigation.sharedEvent(ctx, client, eventMatch[1]!); return; }
    await navigation.load(ctx, client);
    if (data === "checkout:tickets") { await wallet.show(ctx, client); return; }
    if (await wallet.callback(ctx, client, data)) return;
    if (await checkoutCallback(ctx, client, data)) return;
    const buyMatch = buyPattern.exec(data);
    if (buyMatch) await buyFromChat(ctx, client, buyMatch[1] as "ticket" | "table", buyMatch[2]!, buyMatch[3]);
  });
  return bot;
}

async function roleForContext(ctx: Context, api: BotApiClient): Promise<BotRole> {
  if (!isPrivateChat(ctx) || !ctx.from || !ctx.chat) return "guest";
  try {
    return (await api.identity(ctx.from.id, ctx.chat.id)).user.role;
  } catch {
    return "guest";
  }
}

export function parseSearchQuery(text: string | undefined): string {
  const match = /^\/search(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*?))?\s*$/.exec(text ?? "");
  return match?.[1]?.trim().replace(/\s+/g, " ") ?? "";
}
