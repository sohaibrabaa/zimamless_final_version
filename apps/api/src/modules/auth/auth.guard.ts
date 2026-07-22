import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtVerifierService } from './jwt-verifier.service';
import { AuthService } from './auth.service';
import { AppException } from '../../common/errors/app.exception';
import { RequestContextStore } from '../../common/context/request-context';
import {
  IS_PUBLIC_KEY,
  ORG_CONTEXT_EXEMPT_KEY,
  REQUIRED_ROLES_KEY,
  AuthenticatedRequest,
} from './decorators';

export const ORGANIZATION_HEADER = 'x-organization-id';

/**
 * The primary authorization layer (ZM-ARC-003..005), applied globally.
 *
 * Three steps, in order, each a hard gate:
 *   1. Verify the Supabase JWT and sync the platform users row (PA-04).
 *   2. Resolve X-Organization-Id to an ACTIVE membership. Missing or
 *      non-member → 403, per cross-cutting rule 1.
 *   3. Check @RequireRoles against the roles held *in that organization* —
 *      roles are per-membership, never global to the user.
 *
 * RLS in the database is the independent backup for direct-SQL clients. It
 * is not a substitute for this, and this is not a substitute for it: the
 * INV-11 suite proves the policies hold with NestJS bypassed entirely.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtVerifierService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // --- 1. Authenticate -------------------------------------------------
    const token = extractBearer(req.header('authorization'));
    if (!token) throw AppException.unauthenticated();

    const verified = await this.jwt.verify(token);
    const user = await this.auth.syncUser(verified);

    req.user = user;
    req.authUserId = verified.authUserId;
    RequestContextStore.patch({ userId: user.id, authUserId: verified.authUserId });

    // --- 2. Establish organization context -------------------------------
    const exempt = this.reflector.getAllAndOverride<boolean>(ORG_CONTEXT_EXEMPT_KEY, targets);
    if (exempt) return true;

    const orgId = req.header(ORGANIZATION_HEADER)?.trim();
    if (!orgId) throw AppException.organizationContextRequired();
    if (!isUuid(orgId)) {
      // A malformed header is treated as a bad context rather than a
      // validation error, so the 403 semantics of rule 1 hold uniformly and
      // no probe can tell a malformed id from a non-member one.
      throw AppException.organizationContextInvalid();
    }

    const membership = await this.auth.resolveContext(user.id, orgId);
    req.membership = membership;
    req.organizationId = orgId;
    RequestContextStore.patch({
      organizationId: orgId,
      organizationType: membership.organization_type,
      roles: membership.roles,
    });

    // --- 3. Authorize by role -------------------------------------------
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES_KEY, targets);
    if (required?.length) {
      const held = new Set(membership.roles);
      if (!required.some((role) => held.has(role))) throw AppException.insufficientRole(required);
    }

    return true;
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v: string): boolean => UUID_RE.test(v);
