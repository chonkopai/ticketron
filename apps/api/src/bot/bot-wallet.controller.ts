import { eventLocaleSchema, type BotReturnKind } from "@event-platform/shared-types";
import { BadRequestException, Body, Controller, Header, Inject, Param, ParseUUIDPipe, Post, StreamableFile, UseGuards } from "@nestjs/common";
import { BotApiGuard } from "../auth/auth.guards.js";
import { BotWalletService } from "./bot-wallet.service.js";

@Controller("bot/wallet")
@UseGuards(BotApiGuard)
export class BotWalletController {
  constructor(@Inject(BotWalletService) private readonly wallet: BotWalletService) {}

  @Header("Cache-Control", "no-store")
  @Post("events")
  list(@Body() body: unknown) {
    const input = record(body);
    const tab = input.tab;
    if (tab !== "upcoming" && tab !== "past" && tab !== "pending") throw invalid();
    return this.wallet.list(...actor(input), tab, page(input.page), locale(input.locale));
  }

  @Header("Cache-Control", "no-store")
  @Post("events/:id")
  event(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    const input = record(body);
    return this.wallet.event(...actor(input), id, page(input.page), locale(input.locale));
  }

  @Header("Cache-Control", "no-store")
  @Post("orders/:id")
  order(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    const input = record(body);
    return this.wallet.order(...actor(input), id, page(input.page), locale(input.locale));
  }

  @Header("Cache-Control", "no-store")
  @Post("admission/:kind/:id")
  async qr(@Param("kind") kind: string, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    if (kind !== "ticket" && kind !== "group") throw invalid();
    return new StreamableFile(await this.wallet.qr(...actor(record(body)), kind, id), { type: "image/png" });
  }

  @Header("Cache-Control", "no-store")
  @Post("returns/:kind/:id")
  preview(@Param("kind") kind: string, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    return this.wallet.previewReturn(...actor(record(body)), returnKind(kind), id);
  }

  @Header("Cache-Control", "no-store")
  @Post("returns/:kind/:id/confirm")
  confirm(@Param("kind") kind: string, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    const input = record(body);
    if (typeof input.proof !== "string") throw invalid();
    return this.wallet.confirmReturn(...actor(input), returnKind(kind), id, input.proof);
  }

  @Header("Cache-Control", "no-store")
  @Post("orders/:id/claim")
  claim(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() body: unknown) {
    return this.wallet.claim(...actor(record(body)), id);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function actor(input: Record<string, unknown>): [string, string] {
  if (typeof input.telegramId !== "string" || typeof input.chatId !== "string") throw invalid();
  return [input.telegramId, input.chatId];
}
function locale(value: unknown) {
  const result = eventLocaleSchema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function page(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) throw invalid();
  return value;
}
function returnKind(value: string): BotReturnKind {
  if (value !== "ticket" && value !== "booking") throw invalid();
  return value;
}
function invalid() { return new BadRequestException({ code: "BOT_REQUEST_INVALID" }); }
