import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";

import { ROLES_KEY, type AuthenticatedPrincipal } from "./auth.constants.js";

export const Roles = (...roles: AuthenticatedPrincipal["role"][]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<{ user: AuthenticatedPrincipal }>();
    return request.user;
  },
);
