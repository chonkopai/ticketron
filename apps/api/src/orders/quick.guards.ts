import { timingSafeEqual } from "node:crypto";
import { loadApiEnv } from "@event-platform/config";
import { clientAddress } from "../http-client-address.js";
import { RateWindows } from "../rate-windows.js";
import { CanActivate, ExecutionContext, HttpException, Injectable, UnauthorizedException } from "@nestjs/common";

/** Per-process limit per client address and method (see RateWindows). */
@Injectable()
export class QuickRateGuard implements CanActivate {
  private readonly windows = new RateWindows();
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ ip?: string; socket?: { remoteAddress?: string }; method: string }>();
    const key = `${clientAddress(req)}:${req.method}`;
    if (this.windows.hit(key) > (req.method === "GET" ? 120 : 30)) throw new HttpException({ code: "RATE_LIMITED" }, 429);
    return true;
  }
}

@Injectable()
export class QuickBotGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const supplied = context.switchToHttp().getRequest().headers["x-bot-api-secret"];
    const expected = Buffer.from(loadApiEnv().BOT_API_SECRET);
    if (typeof supplied !== "string") throw new UnauthorizedException();
    const value = Buffer.from(supplied);
    if (value.length !== expected.length || !timingSafeEqual(value, expected)) throw new UnauthorizedException();
    return true;
  }
}
