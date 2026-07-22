import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';
import { AuthenticatedRequest } from '../../modules/auth/decorators';

export const AUDIT_ACTION_KEY = 'audit:action';
export const AUDIT_SKIP_KEY = 'audit:skip';

/**
 * Names the audit action and target entity for a route.
 *
 * Without it the interceptor derives both from the HTTP method and path,
 * which is serviceable but vague ("POST /v1/auth/context"). Handlers that
 * matter should say what they did.
 */
export const Audit = (actionType: string, targetEntityType: string) =>
  SetMetadata(AUDIT_ACTION_KEY, { actionType, targetEntityType });

/**
 * Opt out — only for mutations that write their own richer audit entry
 * inside their transaction via AuditService.recordIn(). Never a way to make
 * a mutation unaudited.
 */
export const SkipAudit = () => SetMetadata(AUDIT_SKIP_KEY, true);

/**
 * Catch-all audit coverage for mutations.
 *
 * Hard rule 6 says *every* mutation writes an audit entry. A per-handler
 * discipline would be one forgotten call away from a gap, so this
 * interceptor covers every non-GET route by default and handlers opt out
 * only by writing something better.
 *
 * Two deliberate limits:
 *   - Only successful responses are audited here. Failures are captured by
 *     the exception filter's log line with the same correlation id; writing
 *     audit rows for rejected attempts would fill the trail with noise.
 *   - Before/after values come from handlers that supply them, not from
 *     generic request-body capture: a request body is what was *asked for*,
 *     not what changed, and bodies routinely contain values (the floor,
 *     OTPs) that must not be persisted here.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private static readonly MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!AuditInterceptor.MUTATING.has(req.method)) return next.handle();

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(AUDIT_SKIP_KEY, targets)) return next.handle();

    const declared = this.reflector.getAllAndOverride<{
      actionType: string;
      targetEntityType: string;
    }>(AUDIT_ACTION_KEY, targets);

    return next.handle().pipe(
      tap((result) => {
        const actionType = declared?.actionType ?? `${req.method} ${req.route?.path ?? req.path}`;
        const targetEntityType = declared?.targetEntityType ?? 'HTTP_REQUEST';

        // Fire and forget: awaiting would add a round trip to every mutation
        // response, and AuditService.record() swallows and logs its own
        // failures rather than surfacing them to the client.
        void this.audit.record({
          actionType,
          targetEntityType,
          targetEntityId: extractId(result) ?? pathId(req.params?.id) ?? null,
          newValue: isPlainObject(result) ? result : null,
        });
      }),
    );
  }
}

/**
 * Express types a route param as string | string[] (repeated params). The
 * column is a single uuid, so only a lone string is usable as a target id.
 */
function pathId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function extractId(result: unknown): string | null {
  if (isPlainObject(result) && typeof result.id === 'string') return result.id;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
