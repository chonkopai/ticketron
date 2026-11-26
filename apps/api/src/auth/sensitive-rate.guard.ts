import { CanActivate, type ExecutionContext, HttpException, Injectable } from "@nestjs/common";
import { clientAddress } from "../http-client-address.js";
import { RateWindows } from "../rate-windows.js";
import type { AuthenticatedPrincipal } from "./auth.constants.js";

type Request = { ip?: string; socket?: { remoteAddress?: string }; method?: string; path?: string; user?: AuthenticatedPrincipal };
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi;

/** A bounded per-process brake on expensive or sensitive actions. The DB still
 * enforces uniqueness and authorization; distributed edge limits are a deploy gate.
 * Limits are per process (see RateWindows). */
@Injectable()
export class SensitiveRateGuard implements CanActivate {
  private readonly windows = new RateWindows();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = (request.path ?? "unknown").replace(UUID_SEGMENT, "/:id");
    const actor = request.user?.userId ? `user:${request.user.userId}` : `ip:${clientAddress(request)}`;
    const key = `${actor}:${request.method ?? "POST"}:${path}`;
    const limit = path.includes("telegram/widget") || path.includes("telegram/oidc") ? 10 : path.includes("refresh") ? 60 : path.includes("/use") || path.includes("/inspect") ? 120 : 30;
    if (this.windows.hit(key) > limit) throw new HttpException({ code: "RATE_LIMITED" }, 429);
    return true;
  }
}
