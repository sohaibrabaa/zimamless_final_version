import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request ambient context, carried by AsyncLocalStorage.
 *
 * The audit interceptor needs actor user, actor org, IP, and correlation id
 * on every mutation (brief §7, hard rule 6). Threading four parameters
 * through every service signature would make the audit trail something you
 * can forget to pass; ALS makes it something that is simply there.
 *
 * It is also what lets a log line emitted deep inside a service still carry
 * the correlation id that ties it to the client's request.
 */
export interface RequestContext {
  /** Correlation id — echoed to the client and written to every audit row. */
  correlationId: string;
  /** platform users.id. Absent on unauthenticated routes. */
  userId?: string;
  /** Supabase auth.users.id from the JWT `sub` claim. */
  authUserId?: string;
  /** The ACTIVE organization context from X-Organization-Id. */
  organizationId?: string;
  organizationType?: 'SUPPLIER' | 'BANK' | 'PLATFORM';
  roles?: string[];
  ipAddress?: string;
  userAgent?: string;
  method?: string;
  path?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
  },

  get(): RequestContext | undefined {
    return storage.getStore();
  },

  /**
   * Mutate the active context. The auth guard runs after the correlation-id
   * middleware has already opened the store, so it fills in the identity
   * once the token is verified rather than opening a second scope.
   */
  patch(patch: Partial<RequestContext>): void {
    const current = storage.getStore();
    if (current) Object.assign(current, patch);
  },

  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
};
