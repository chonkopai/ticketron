import { readFile } from "node:fs/promises";
import { BadRequestException, Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, ServiceUnavailableException, StreamableFile, UseGuards } from "@nestjs/common";
import { QuickRateGuard } from "../orders/quick.guards.js";
import { seatUuid } from "./telegram-seat-auth.js";
import { TelegramSeatService } from "./telegram-seat.service.js";

const scope = "telegram/seats";
const noStore = "private, no-store";
const shellPolicy = [
  "default-src 'none'", "script-src 'self' https://telegram.org", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'", "frame-ancestors https://web.telegram.org", "base-uri 'none'", "form-action 'none'",
].join("; ");

@Controller(scope)
@UseGuards(QuickRateGuard)
export class TelegramSeatController {
  constructor(@Inject(TelegramSeatService) private readonly seat: TelegramSeatService) {}

  @Get()
  @Header("Cache-Control", noStore)
  @Header("Content-Security-Policy", shellPolicy)
  @Header("Referrer-Policy", "no-referrer")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("X-Robots-Tag", "noindex, nofollow")
  shell() {
    return this.asset("index.html", "text/html; charset=utf-8");
  }

  @Get("app.js")
  @Header("Cache-Control", "no-cache")
  @Header("X-Content-Type-Options", "nosniff")
  script() { return this.asset("app.js", "text/javascript; charset=utf-8"); }

  @Get("app.css")
  @Header("Cache-Control", "no-cache")
  @Header("X-Content-Type-Options", "nosniff")
  styles() { return this.asset("app.css", "text/css; charset=utf-8"); }

  @Post("session")
  @HttpCode(200)
  @Header("Cache-Control", noStore)
  exchange(@Body() body: { initData?: unknown } | undefined) { return this.seat.exchange(body?.initData); }

  @Get("catalogue")
  @Header("Cache-Control", noStore)
  async catalogue(@Headers("authorization") authorization?: string) {
    return this.seat.catalogue(await this.seat.authenticate(authorization));
  }

  @Post("quote")
  @HttpCode(200)
  @Header("Cache-Control", noStore)
  async quote(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.seat.quote(await this.seat.authenticate(authorization), body);
  }

  @Post("confirm/:reference")
  @HttpCode(200)
  @Header("Cache-Control", noStore)
  async confirm(@Param("reference") reference: string, @Body() body: { termsAccepted?: unknown } | undefined, @Headers("authorization") authorization?: string) {
    const session = await this.seat.authenticate(authorization);
    if (body?.termsAccepted !== true || !seatUuid.test(reference)) throw new BadRequestException({ code: "CART_CONFIRMATION_INVALID" });
    return this.seat.confirm(session, reference.toLowerCase());
  }

  @Get("order")
  @Header("Cache-Control", noStore)
  async latestOrder(@Headers("authorization") authorization?: string) {
    // Nest maps a bare null to an empty body.
    return { order: await this.seat.order(await this.seat.authenticate(authorization)) };
  }

  @Get("order/:id")
  @Header("Cache-Control", noStore)
  async order(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    const session = await this.seat.authenticate(authorization);
    if (!seatUuid.test(id)) throw new BadRequestException({ code: "BOT_ORDER_NOT_FOUND" });
    return this.seat.order(session, id.toLowerCase());
  }

  @Post("order/:id/resume")
  @HttpCode(200)
  @Header("Cache-Control", noStore)
  async resume(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    const session = await this.seat.authenticate(authorization);
    if (!seatUuid.test(id)) throw new BadRequestException({ code: "BOT_ORDER_NOT_FOUND" });
    return this.seat.order(session, id.toLowerCase(), true);
  }

  private async asset(name: string, type: string) {
    this.seat.assertEnabled();
    try {
      const bytes = await readFile(new URL(`../../../web/dist/telegram-seats/${name}`, import.meta.url));
      return new StreamableFile(bytes, { type });
    } catch {
      throw new ServiceUnavailableException({ code: "TELEGRAM_SEAT_ASSET_UNAVAILABLE" });
    }
  }
}
