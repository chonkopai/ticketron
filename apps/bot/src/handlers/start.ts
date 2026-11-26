import {
  ru,
  quickRu,
  TELEGRAM_LINK_TOKEN_PATTERN,
  type TelegramLinkAnswerRequest,
  type TelegramLinkAnswerResponse,
  type TelegramLinkConsumeRequest,
  type TelegramLinkConsumeResponse,
} from "@event-platform/shared-types";
import type { Context } from "grammy";

import { formatWelcome } from "../presentation.js";
import { checkoutReference } from "../checkout.js";

export interface StartHandlerOptions {
  apiBaseUrl: string;
  botApiSecret: string;
  fetch?: typeof globalThis.fetch;
  getWelcome?: (ctx: Context) => Promise<string>;
  showHome?: (ctx: Context) => Promise<void>;
  openOrder?: (ctx: Context, orderId: string) => Promise<void>;
  openEvent?: (ctx: Context, eventId: string) => Promise<void>;
  openEventDay?: (ctx: Context, eventId: string) => Promise<void>;
  openConversation?: (ctx: Context, payload: string) => Promise<void>;
}

export function createStartHandler(options: StartHandlerOptions): (ctx: Context) => Promise<void> {
  const request = options.fetch ?? globalThis.fetch;

  return async (ctx: Context): Promise<void> => {
    const token = parseStartToken(ctx.message?.text);
    if (!token) {
      await replyWelcome(ctx, options);
      return;
    }
    if (!ctx.from || !ctx.chat) {
      await ctx.reply(ru.bot.unableToIdentify);
      return;
    }

    if (token.startsWith("q_")) {
      if (ctx.chat.type !== "private") { await ctx.reply(ru.bot.unableToIdentify); return; }
      const message = await ctx.reply(quickRu.botPending);
      const response = await request(new URL("/quick/verify", options.apiBaseUrl), {
        method: "POST", headers: { "content-type": "application/json", "x-bot-api-secret": options.botApiSecret },
        body: JSON.stringify({ token: token.slice(2), telegramId: String(ctx.from.id), chatId: String(ctx.chat.id), messageId: message.message_id }),
      });
      if (!response.ok) await ctx.reply(ru.bot.invalidLink);
      else await ctx.reply(quickRu.botVerified);
      await replyWelcome(ctx, options);
      return;
    }

    if (ctx.chat.type !== "private" || ctx.chat.id !== ctx.from.id) {
      await ctx.reply(ru.bot.unableToIdentify);
      return;
    }

    if (options.openConversation && new RegExp(`^c_[ga]_[oi]_${checkoutReference}$`).test(token)) {
      await options.openConversation(ctx, token);
      return;
    }
    const order = new RegExp(`^p_(${checkoutReference})$`).exec(token);
    if (order && options.openOrder) {
      await options.openOrder(ctx, order[1]!);
      return;
    }
    const event = new RegExp(`^e_(${checkoutReference})$`).exec(token);
    if (event && options.openEvent) {
      await options.openEvent(ctx, event[1]!);
      return;
    }
    const eventDay = new RegExp(`^d_(${checkoutReference})$`).exec(token);
    if (eventDay && options.openEventDay) {
      await options.openEventDay(ctx, eventDay[1]!);
      return;
    }

    if (!TELEGRAM_LINK_TOKEN_PATTERN.test(token)) {
      await ctx.reply(ru.bot.invalidLink);
      await replyWelcome(ctx, options);
      return;
    }
    const body: TelegramLinkConsumeRequest = { token, telegramId: ctx.from.id, chatId: ctx.chat.id };
    const response = await request(new URL("/auth/telegram/link/consume", options.apiBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bot-api-secret": options.botApiSecret,
      },
      body: JSON.stringify(body),
    });

    const outcome = response.ok
      ? await response.json().catch(() => null) as Partial<TelegramLinkConsumeResponse> | null
      : null;
    if (!outcome || typeof outcome.attemptId !== "string" || outcome.attemptId.length !== 36 || typeof outcome.account !== "string") {
      await ctx.reply(ru.bot.invalidLink);
      await replyWelcome(ctx, options);
      return;
    }
    await ctx.reply(ru.bot.linkConfirmPrompt(outcome.account), {
      reply_markup: {
        inline_keyboard: [[
          { text: ru.bot.linkConfirmButton, callback_data: `tl:y:${outcome.attemptId}` },
          { text: ru.bot.linkCancelButton, callback_data: `tl:n:${outcome.attemptId}` },
        ]],
      },
    });
  };
}

export const LINK_CALLBACK_PATTERN = /^tl:([yn]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function createLinkCallbackHandler(
  options: Pick<StartHandlerOptions, "apiBaseUrl" | "botApiSecret" | "fetch">,
): (ctx: Context, data: string) => Promise<boolean> {
  const request = options.fetch ?? globalThis.fetch;

  return async (ctx: Context, data: string): Promise<boolean> => {
    const m = LINK_CALLBACK_PATTERN.exec(data);
    if (!m) return false;
    const chat = ctx.callbackQuery?.message?.chat;
    if (!ctx.from || !chat || chat.type !== "private" || chat.id !== ctx.from.id) {
      await ctx.reply(ru.bot.unableToIdentify);
      return true;
    }
    const body: TelegramLinkAnswerRequest = {
      attemptId: m[2]!,
      telegramId: ctx.from.id,
      chatId: chat.id,
      decision: m[1] === "y" ? "confirm" : "cancel",
      firstName: ctx.from.first_name,
      ...(ctx.from.last_name ? { lastName: ctx.from.last_name } : {}),
    };
    let text: string = ru.bot.invalidLink;
    try {
      const response = await request(new URL("/auth/telegram/link/answer", options.apiBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "x-bot-api-secret": options.botApiSecret },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const outcome = await response.json() as Partial<TelegramLinkAnswerResponse>;
        if (outcome.state === "pending") text = ru.bot.linkPending;
        else if (outcome.state === "linked") text = ru.bot.linked;
        else if (outcome.state === "cancelled") text = ru.bot.linkCancelled;
      }
    } catch {
      text = ru.bot.invalidLink;
    }
    try {
      await ctx.editMessageText(text);
    } catch {
      await ctx.reply(text);
    }
    return true;
  };
}

async function replyWelcome(ctx: Context, options: StartHandlerOptions): Promise<void> {
  try {
    if (options.showHome) await options.showHome(ctx);
    else await ctx.reply(options.getWelcome ? await options.getWelcome(ctx) : formatWelcome("guest"));
  } catch {
    await ctx.reply(formatWelcome("guest"));
  }
}

export function parseStartToken(text: string | undefined): string | null {
  if (!text) return null;
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(text);
  return match?.[1] ?? null;
}
