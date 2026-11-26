import type { AccountSessionList } from "@event-platform/shared-types";
import { Controller, Get, Header, Inject, Post, UseGuards } from "@nestjs/common";

import { CurrentUser } from "./auth.decorators.js";
import { JwtAuthGuard } from "./auth.guards.js";
import type { AuthenticatedPrincipal } from "./auth.constants.js";
import { SensitiveRateGuard } from "./sensitive-rate.guard.js";
import { TokenService } from "./token.service.js";

/** Signed-in sessions and "sign out everywhere". Works for passwordless accounts too. */
@Controller("me/sessions")
@UseGuards(JwtAuthGuard, SensitiveRateGuard)
export class SessionsController {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@CurrentUser() user: AuthenticatedPrincipal): Promise<AccountSessionList> {
    return this.tokens.listSessions(user.userId, user.sessionFamilyId);
  }

  @Post("revoke-all")
  @Header("Cache-Control", "no-store")
  revokeAll(@CurrentUser() user: AuthenticatedPrincipal): Promise<{ revoked: number }> {
    return this.tokens.revokeAllSessions(user.userId);
  }
}
