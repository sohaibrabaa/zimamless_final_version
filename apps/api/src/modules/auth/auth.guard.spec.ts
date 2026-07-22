import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, ORGANIZATION_HEADER } from './auth.guard';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { IS_PUBLIC_KEY, ORG_CONTEXT_EXEMPT_KEY, REQUIRED_ROLES_KEY } from './decorators';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * The org-context guard is cross-cutting rule 1 of the contract, and its
 * failure modes are security-relevant: a 403 that leaks whether an
 * organization exists is an enumeration oracle, and a role check that reads
 * roles globally rather than per-membership silently grants a supplier's
 * permissions inside a bank.
 */

const USER = { id: 'user-1', preferred_language: 'EN' };
const ORG_ID = '0e000000-0000-4000-8000-000000000004';
const OTHER_ORG_ID = '0e000000-0000-4000-8000-000000000005';

function makeContext(options: {
  authorization?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
  method?: string;
}): { context: ExecutionContext; req: Record<string, unknown> } {
  const headers: Record<string, string> = {};
  if (options.authorization) headers.authorization = options.authorization;
  if (options.organizationId) headers[ORGANIZATION_HEADER] = options.organizationId;

  const req: Record<string, unknown> = {
    method: options.method ?? 'GET',
    header: (name: string) => headers[name.toLowerCase()],
  };

  const context = {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;

  return { context, req };
}

function makeGuard(overrides: {
  metadata?: Record<string, unknown>;
  verify?: jest.Mock;
  syncUser?: jest.Mock;
  resolveContext?: jest.Mock;
  listMemberships?: jest.Mock;
}) {
  const reflector = {
    getAllAndOverride: (key: string) => overrides.metadata?.[key],
  } as unknown as Reflector;

  const jwt = { verify: overrides.verify ?? jest.fn().mockResolvedValue({ authUserId: 'auth-1' }) };
  const auth = {
    syncUser: overrides.syncUser ?? jest.fn().mockResolvedValue(USER),
    resolveContext:
      overrides.resolveContext ??
      jest.fn().mockResolvedValue({
        organization_id: ORG_ID,
        organization_type: 'BANK',
        roles: ['BANK_OFFER_MAKER'],
      }),
    listMemberships: overrides.listMemberships ?? jest.fn().mockResolvedValue([]),
  };

  return {
    guard: new AuthGuard(reflector, jwt as never, auth as never),
    jwt,
    auth,
  };
}

/** Runs the guard inside a request context, as the middleware would. */
function run(guard: AuthGuard, context: ExecutionContext): Promise<boolean> {
  return RequestContextStore.run({ correlationId: 'test-correlation' }, () =>
    guard.canActivate(context),
  );
}

describe('AuthGuard', () => {
  describe('authentication', () => {
    it('allows a @Public route with no token at all', async () => {
      const { guard } = makeGuard({ metadata: { [IS_PUBLIC_KEY]: true } });
      const { context } = makeContext({});
      await expect(run(guard, context)).resolves.toBe(true);
    });

    it('rejects a request with no Authorization header', async () => {
      const { guard } = makeGuard({});
      const { context } = makeContext({ organizationId: ORG_ID });
      await expect(run(guard, context)).rejects.toThrow(AppException);
    });

    it('rejects a non-Bearer scheme', async () => {
      const { guard } = makeGuard({});
      const { context } = makeContext({ authorization: 'Basic abc123', organizationId: ORG_ID });
      await expect(run(guard, context)).rejects.toThrow(AppException);
    });

    it('rejects an empty bearer value', async () => {
      const { guard } = makeGuard({});
      const { context } = makeContext({ authorization: 'Bearer   ', organizationId: ORG_ID });
      await expect(run(guard, context)).rejects.toThrow(AppException);
    });

    it('propagates a token-verification failure', async () => {
      const { guard } = makeGuard({
        verify: jest.fn().mockRejectedValue(AppException.unauthenticated()),
      });
      const { context } = makeContext({ authorization: 'Bearer bad', organizationId: ORG_ID });
      await expect(run(guard, context)).rejects.toThrow(AppException);
    });

    it('syncs the platform users row on first authenticated request (PA-04)', async () => {
      const syncUser = jest.fn().mockResolvedValue(USER);
      const { guard } = makeGuard({ syncUser });
      const { context, req } = makeContext({ authorization: 'Bearer ok', organizationId: ORG_ID });

      await run(guard, context);

      expect(syncUser).toHaveBeenCalledWith({ authUserId: 'auth-1' });
      expect(req.user).toBe(USER);
      expect(req.authUserId).toBe('auth-1');
    });
  });

  describe('organization context (cross-cutting rule 1)', () => {
    it('rejects a missing X-Organization-Id with 403, not 400', async () => {
      // Rule 1 is explicit that the absence of context is a 403. A 400 would
      // tell a caller the request was merely malformed rather than refused.
      const { guard } = makeGuard({});
      const { context } = makeContext({ authorization: 'Bearer ok' });

      await expect(run(guard, context)).rejects.toMatchObject({
        code: ErrorCode.ORGANIZATION_CONTEXT_REQUIRED,
        status: 403,
      });
    });

    it('rejects a malformed organization id with the same 403 as a non-member', async () => {
      // Both must be indistinguishable to the caller, otherwise the pair of
      // responses becomes an oracle for which organization ids exist.
      const { guard } = makeGuard({});
      const { context } = makeContext({ authorization: 'Bearer ok', organizationId: 'not-a-uuid' });

      const error = await run(guard, context).catch((e) => e);
      expect(error.status).toBe(403);
    });

    it('rejects an organization the user does not belong to', async () => {
      const resolveContext = jest.fn().mockRejectedValue(AppException.organizationContextInvalid());
      const { guard } = makeGuard({ resolveContext });
      const { context } = makeContext({
        authorization: 'Bearer ok',
        organizationId: OTHER_ORG_ID,
      });

      await expect(run(guard, context)).rejects.toMatchObject({ status: 403 });
    });

    it('attaches the resolved membership to the request', async () => {
      const { guard } = makeGuard({});
      const { context, req } = makeContext({ authorization: 'Bearer ok', organizationId: ORG_ID });

      await run(guard, context);

      expect(req.organizationId).toBe(ORG_ID);
      expect(req.membership).toMatchObject({ organization_type: 'BANK' });
    });

    it('skips the context requirement only for an exempt route', async () => {
      // /onboarding/register is the single exemption (D-04): the caller has
      // no organization yet, by definition.
      const resolveContext = jest.fn();
      const { guard } = makeGuard({
        metadata: { [ORG_CONTEXT_EXEMPT_KEY]: true },
        resolveContext,
      });
      const { context } = makeContext({ authorization: 'Bearer ok' });

      await expect(run(guard, context)).resolves.toBe(true);
      expect(resolveContext).not.toHaveBeenCalled();
    });

    it('records the context for audit and logging', async () => {
      const { guard } = makeGuard({});
      const { context } = makeContext({ authorization: 'Bearer ok', organizationId: ORG_ID });

      await RequestContextStore.run({ correlationId: 'c1' }, async () => {
        await guard.canActivate(context);
        // The audit interceptor reads actor org from here, so a context that
        // does not propagate produces audit rows with a null actor_org_id.
        expect(RequestContextStore.get()?.organizationId).toBe(ORG_ID);
        expect(RequestContextStore.get()?.userId).toBe(USER.id);
      });
    });
  });

  describe('exempt mutations still name an actor organization (hard rule 6)', () => {
    // The audit interceptor reads actor_org_id straight out of the request
    // context. An exempt *mutation* — PATCH /auth/language is one — that runs
    // with no context therefore writes an audit row with a null actor org,
    // which hard rule 6 forbids. A GET may legitimately have no context.
    const ONE_MEMBERSHIP = [
      { organization_id: ORG_ID, organization_type: 'SUPPLIER', roles: ['SUPPLIER_OWNER'] },
    ];
    const TWO_MEMBERSHIPS = [
      ...ONE_MEMBERSHIP,
      { organization_id: OTHER_ORG_ID, organization_type: 'PLATFORM', roles: ['PLATFORM_SUPPORT'] },
    ];

    it('adopts the sole membership when an exempt mutation sends no header', async () => {
      const listMemberships = jest.fn().mockResolvedValue(ONE_MEMBERSHIP);
      const { guard } = makeGuard({
        metadata: { [ORG_CONTEXT_EXEMPT_KEY]: true },
        listMemberships,
      });
      const { context, req } = makeContext({ authorization: 'Bearer ok', method: 'PATCH' });

      await expect(run(guard, context)).resolves.toBe(true);
      expect(req.organizationId).toBe(ORG_ID);
    });

    it('refuses an exempt mutation from a multi-org user with no header', async () => {
      // Guessing would attribute the write to an arbitrary one of their orgs.
      const { guard } = makeGuard({
        metadata: { [ORG_CONTEXT_EXEMPT_KEY]: true },
        listMemberships: jest.fn().mockResolvedValue(TWO_MEMBERSHIPS),
      });
      const { context } = makeContext({ authorization: 'Bearer ok', method: 'PATCH' });

      await expect(run(guard, context)).rejects.toMatchObject({
        code: ErrorCode.ORGANIZATION_CONTEXT_REQUIRED,
        status: 403,
      });
    });

    it('leaves the actor org in the context for the audit interceptor', async () => {
      const { guard } = makeGuard({
        metadata: { [ORG_CONTEXT_EXEMPT_KEY]: true },
        listMemberships: jest.fn().mockResolvedValue(ONE_MEMBERSHIP),
      });
      const { context } = makeContext({ authorization: 'Bearer ok', method: 'PATCH' });

      await RequestContextStore.run({ correlationId: 'c1' }, async () => {
        await guard.canActivate(context);
        expect(RequestContextStore.get()?.organizationId).toBe(ORG_ID);
      });
    });

    it('still allows an exempt GET with no context at all', async () => {
      // /auth/me has to work before the client knows any organization id.
      const listMemberships = jest.fn();
      const { guard } = makeGuard({
        metadata: { [ORG_CONTEXT_EXEMPT_KEY]: true },
        listMemberships,
      });
      const { context, req } = makeContext({ authorization: 'Bearer ok', method: 'GET' });

      await expect(run(guard, context)).resolves.toBe(true);
      expect(req.organizationId).toBeUndefined();
      expect(listMemberships).not.toHaveBeenCalled();
    });
  });

  describe('role checks', () => {
    it('allows a user holding one of the required roles', async () => {
      const { guard } = makeGuard({
        metadata: { [REQUIRED_ROLES_KEY]: ['BANK_OFFER_MAKER', 'BANK_ADMIN'] },
      });
      const { context } = makeContext({ authorization: 'Bearer ok', organizationId: ORG_ID });
      await expect(run(guard, context)).resolves.toBe(true);
    });

    it('rejects a user without any required role', async () => {
      const { guard } = makeGuard({
        metadata: { [REQUIRED_ROLES_KEY]: ['BANK_OFFER_APPROVER'] },
      });
      const { context } = makeContext({ authorization: 'Bearer ok', organizationId: ORG_ID });

      await expect(run(guard, context)).rejects.toMatchObject({
        code: ErrorCode.INSUFFICIENT_ROLE,
        status: 403,
      });
    });

    it('reads roles from the active membership, not globally from the user', async () => {
      // The multi-org case: PLATFORM_SUPPORT in one org and SUPPLIER_VIEWER
      // in another must not combine. Roles are per-membership.
      const resolveContext = jest.fn().mockResolvedValue({
        organization_id: ORG_ID,
        organization_type: 'SUPPLIER',
        roles: ['SUPPLIER_VIEWER'],
      });
      const { guard } = makeGuard({
        metadata: { [REQUIRED_ROLES_KEY]: ['PLATFORM_SUPPORT'] },
        resolveContext,
      });
      const { context } = makeContext({ authorization: 'Bearer ok', organizationId: ORG_ID });

      await expect(run(guard, context)).rejects.toMatchObject({ status: 403 });
    });
  });
});
