import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { PlatformUser, MembershipRow } from './auth.service';

export const IS_PUBLIC_KEY = 'auth:public';
export const ORG_CONTEXT_EXEMPT_KEY = 'auth:orgContextExempt';
export const REQUIRED_ROLES_KEY = 'auth:requiredRoles';

/**
 * No token required. Reserved for /health — every other route in the
 * contract sits behind `security: bearerAuth`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Authenticated, but exempt from X-Organization-Id.
 *
 * The exemption exists for exactly two situations, both of which are
 * chicken-and-egg by nature:
 *   - /auth/me and /auth/context, which are how a client discovers and
 *     chooses a context in the first place;
 *   - /onboarding/register (D-04), where the caller has no organization yet.
 *     The amendment documents that exemption explicitly.
 *
 * Anything else carrying this decorator is a bug: cross-cutting rule 1 says
 * every request names its active organization.
 */
export const OrgContextExempt = () => SetMetadata(ORG_CONTEXT_EXEMPT_KEY, true);

/** Require any one of these role_key values in the active org context. */
export const RequireRoles = (...roles: string[]) => SetMetadata(REQUIRED_ROLES_KEY, roles);

/**
 * An exempt mutation that *creates* the caller's first organization.
 *
 * Only `/onboarding/register` (D-04). It needs its own marker because the
 * exempt-mutation rule — adopt a sole membership, otherwise refuse — is
 * correct for `/auth/language` and exactly wrong here: a first-time
 * registrant has ZERO memberships, so that rule would refuse the one call
 * whose entire purpose is to give them one.
 *
 * This is not a hole in hard rule 6. The handler MUST patch the request
 * context with the organization it creates, so the audit row still names an
 * actor org — the org simply does not exist until the handler runs. The
 * guard test suite pins both halves.
 */
export const BOOTSTRAPS_ORGANIZATION_KEY = 'auth:bootstrapsOrganization';
export const BootstrapsOrganization = () => SetMetadata(BOOTSTRAPS_ORGANIZATION_KEY, true);

export interface AuthenticatedRequest extends Request {
  user?: PlatformUser;
  authUserId?: string;
  membership?: MembershipRow;
  organizationId?: string;
}

/** The platform `users` row for the caller. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
});

/** The active organization context — membership, roles, org type. */
export const CurrentContext = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().membership;
});
