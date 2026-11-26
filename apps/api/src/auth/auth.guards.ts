import { timingSafeEqual } from "node:crypto";

import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import {
  AUTH_CONFIG,
  ROLES_KEY,
  type AuthConfig,
  type AuthenticatedPrincipal,
} from "./auth.constants.js";
import { AuthService } from "./auth.service.js";

type AuthCarrier = {
  headers?: Record<string, string | string[] | undefined>;
  handshake?: { headers?: Record<string, string | string[] | undefined> };
  user?: AuthenticatedPrincipal;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const carrier = getCarrier(context);
    if (context.getType<string>() === "http") context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>().setHeader("Cache-Control", "private, no-store");
    const authorization = readHeader(carrier, "authorization");
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!match?.[1]) throw new UnauthorizedException("A bearer access token is required");

    carrier.user = await this.auth.authenticate(match[1]);
    const request = context.switchToHttp().getRequest<{method?:string;path?:string}>();
    if (carrier.user.restricted && request.method !== "GET") throw new ForbiddenException({code:"ACCOUNT_RESTRICTED"});
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<AuthenticatedPrincipal["role"][]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed?.length) return true;

    const user = getCarrier(context).user;
    if (!user) throw new UnauthorizedException();
    if (user.restricted) throw new ForbiddenException({code:"ACCOUNT_RESTRICTED"});
    if (!allowed.includes(user.role)) throw new ForbiddenException("This role cannot access the resource");
    return true;
  }
}

@Injectable()
export class BotApiGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const provided = readHeader(getCarrier(context), "x-bot-api-secret");
    const expected = this.config.botApiSecret;
    if (!provided || !constantTimeEqual(provided, expected)) {
      throw new UnauthorizedException("Bot API credentials are invalid");
    }
    return true;
  }
}

function getCarrier(context: ExecutionContext): AuthCarrier {
  return context.getType<string>() === "ws"
    ? context.switchToWs().getClient<AuthCarrier>()
    : context.switchToHttp().getRequest<AuthCarrier>();
}

function readHeader(carrier: AuthCarrier, name: string): string | undefined {
  const value = carrier.headers?.[name] ?? carrier.handshake?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
