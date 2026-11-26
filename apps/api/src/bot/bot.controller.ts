import type { BotIdentityResponse } from "@event-platform/shared-types";
import { COUNTRY_CODES, eventLocaleSchema, type BotGuestSettingsUpdate } from "@event-platform/shared-types";
import { BadRequestException, Body, Controller, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";

import { BotApiGuard } from "../auth/auth.guards.js";
import { BotCheckoutService } from "./bot-checkout.service.js";
import { BotGuestService } from "./bot-guest.service.js";
import { BotService } from "./bot.service.js";

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
  return value as Record<string, unknown>;
}
function number(value: unknown, fallback: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
  return parsed;
}
const uuid = new ParseUUIDPipe({ version: "4" });
function checkoutActor(input: Record<string, unknown>) {
  if (typeof input.telegramId !== "string" || typeof input.chatId !== "string") throw new BadRequestException({ code: "BOT_PRIVATE_CHAT_REQUIRED" });
  return [input.telegramId, input.chatId] as const;
}

@Controller("bot")
@UseGuards(BotApiGuard)
export class BotController {
  constructor(
    @Inject(BotService) private readonly service: BotService,
    @Inject(BotCheckoutService) private readonly checkout: BotCheckoutService,
    @Inject(BotGuestService) private readonly guest: BotGuestService,
  ) {}

  @Post("guest/settings") @Header("Cache-Control", "no-store")
  guestSettings(@Body() body: unknown) { return this.guest.settings(...checkoutActor(objectBody(body))); }

  @Post("guest/preferences") @Header("Cache-Control", "no-store")
  updateGuestSettings(@Body() body: unknown) {
    const input = objectBody(body);
    const changes: BotGuestSettingsUpdate = {};
    if (input.locale !== undefined) {
      const locale = eventLocaleSchema.safeParse(input.locale);
      if (!locale.success) throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
      changes.locale = locale.data;
    }
    if (input.location === null) changes.location = null;
    else if (input.location !== undefined) {
      const location = objectBody(input.location);
      if (typeof location.city !== "string" || !location.city.trim() || location.city.length > 120 ||
          (location.countryCode !== null && !COUNTRY_CODES.some(code => code === location.countryCode))) {
        throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
      }
      changes.location = { city: location.city.trim(), countryCode: location.countryCode as string | null };
    }
    if (!Object.keys(changes).length) throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
    return this.guest.update(...checkoutActor(input), changes);
  }

  @Post("guest/messages") @Header("Cache-Control", "no-store")
  guestMessages(@Body() body: unknown) {
    const input = objectBody(body);
    const locale = eventLocaleSchema.safeParse(input.locale);
    if (!locale.success) throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
    return this.guest.messages(...checkoutActor(input), locale.data, number(input.page, 1, 1000));
  }

  @Post("write-access")
  grantWriteAccess(@Body() body: unknown) {
    const input = objectBody(body);
    if (typeof input.telegramId !== "string" || typeof input.chatId !== "string") throw new BadRequestException({ code: "BOT_IDENTITY_INVALID" });
    return this.service.grantWriteAccess({ telegramId: input.telegramId, chatId: input.chatId });
  }

  @Post("identity")
  identity(@Body() body: unknown): Promise<BotIdentityResponse> {
    const input = objectBody(body);
    if (typeof input.telegramId !== "string" || typeof input.chatId !== "string") throw new BadRequestException({ code: "BOT_IDENTITY_INVALID" });
    return this.service.identity({ telegramId: input.telegramId, chatId: input.chatId });
  }

  @Post("checkout/offers") @Header("Cache-Control", "no-store")
  async prepareCheckout(@Body() body: unknown) {
    const input = objectBody(body);
    const locale = eventLocaleSchema.safeParse(input.locale);
    if ((input.kind !== "ticket" && input.kind !== "table") || typeof input.itemId !== "string" || typeof input.name !== "string" || !locale.success) {
      throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
    }
    const itemId = await uuid.transform(input.itemId, { type: "body" });
    if (!itemId) throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
    return this.checkout.prepare(...checkoutActor(input), input.name.trim().slice(0, 120) || "Guest", { kind: input.kind, itemId, locale: locale.data });
  }

  @Post("checkout/offers/:id/confirm") @Header("Cache-Control", "no-store")
  confirmCheckout(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    const input = objectBody(body);
    if (typeof input.messageId !== "number" || !Number.isSafeInteger(input.messageId) || input.messageId < 1 || input.messageId > 2147483647) {
      throw new BadRequestException({ code: "BOT_REQUEST_INVALID" });
    }
    return this.checkout.confirm(...checkoutActor(input), id, input.messageId);
  }

  @Post("checkout/orders") @Header("Cache-Control", "no-store")
  listCheckoutOrders(@Body() body: unknown) {
    const input = objectBody(body);
    return this.checkout.list(...checkoutActor(input), number(input.page, 1, 1000));
  }

  @Post("checkout/orders/:id") @Header("Cache-Control", "no-store")
  checkoutOrder(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    const input = objectBody(body);
    return this.checkout.order(...checkoutActor(input), id, input.resume === true);
  }

  @Post("updates/claim")
  @HttpCode(200)
  claim(@Body() body: unknown) {
    const input = objectBody(body);
    if (typeof input.botId !== "string" || typeof input.updateId !== "string" || typeof input.payloadHash !== "string") throw new BadRequestException({ code: "BOT_UPDATE_INVALID" });
    return this.service.claimUpdate(input.botId, input.updateId, input.payloadHash);
  }

  @Post("updates/complete")
  @HttpCode(204)
  async complete(@Body() body: unknown): Promise<void> {
    const input = objectBody(body);
    if (typeof input.botId !== "string" || typeof input.updateId !== "string" || typeof input.payloadHash !== "string") throw new BadRequestException({ code: "BOT_UPDATE_INVALID" });
    await this.service.completeUpdate(input.botId, input.updateId, input.payloadHash, input.failed === true);
  }
}
