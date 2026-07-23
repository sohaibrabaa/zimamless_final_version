import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { createHash } from 'node:crypto';
import { Observable, catchError, from, map, of, switchMap, throwError } from 'rxjs';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { AuthenticatedRequest } from '../../modules/auth/decorators';

export const IDEMPOTENT_KEY = 'idempotency:required';

/**
 * Marks a route as requiring an `Idempotency-Key` header, and makes that
 * header actually do something.
 *
 * Contract global rule 4: "All POST endpoints that move money or change
 * financial state require an `Idempotency-Key` header." The OpenAPI marks the
 * parameter `required: true` on exactly those routes. Put this decorator on
 * each of them; the interceptor below enforces the header and replays the
 * first response for a repeated key.
 *
 * Today that is `offers/{id}/accept`. The funding, settlement, buyer-payment
 * and recourse endpoints the contract also flags are Phases 7-9 — unbuilt —
 * and each will carry this decorator when it lands.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

/**
 * Header-level idempotency for money/state-changing POSTs.
 *
 * The mechanism, in order:
 *   1. A flagged route with no `Idempotency-Key` is refused (400) — the
 *      contract says the header is required, so an absent one is a client
 *      error, not a silent pass.
 *   2. The (organization, key) pair is *claimed* with an INSERT before the
 *      handler runs. The winner of that insert executes the request; a
 *      concurrent duplicate loses the insert, sees the claim still in
 *      progress, and is told so rather than executing a second time.
 *   3. When the handler succeeds, its response and status are stored on the
 *      claim. A later replay of the same key returns exactly that, without
 *      re-executing — no second snapshot, no second audit row.
 *   4. A key replayed against a *different* request (method, path, or body)
 *      is a conflict, not a replay: the client reused a key it should not
 *      have.
 *   5. A handler that FAILS releases its claim, so the client can retry the
 *      same key once the cause is fixed. Idempotency protects against
 *      duplicate success, not against retrying a failure.
 *
 * This sits OUTSIDE the audit interceptor (registered before it), so a
 * replay short-circuits before any audit row is written — the original
 * request already recorded what happened.
 *
 * Writes go through the service-role connection, which bypasses RLS by
 * design; the row's own `organization_id` is what scopes it.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private static readonly MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    if (!IdempotencyInterceptor.MUTATING.has(req.method)) return next.handle();

    const key = headerValue(req.headers['idempotency-key']);
    if (!key) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'This request requires an Idempotency-Key header.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const orgId = req.membership?.organization_id ?? req.organizationId ?? null;
    // A flagged route always sits behind the org-context guard, so this is
    // belt-and-braces: with no org to scope the key to, do not pretend to
    // dedupe — let the request run and let the guard's own refusal stand.
    if (!orgId) return next.handle();

    // The ACTUAL url, not `req.route.path`: the route pattern is
    // `/offers/:id/accept`, identical for every offer, so fingerprinting on it
    // would make one key accepted for offer A look like a replay when reused
    // for offer B. `originalUrl` carries the real id (and any query), which is
    // what makes the reused-key-different-request case a conflict, not a replay.
    const path = req.originalUrl ?? req.url;
    const requestHash = hashRequest(req.method, path, req.body);

    return from(this.claim(orgId, key, req.method, path, requestHash)).pipe(
      switchMap((claim) => {
        if (claim === 'won') {
          return next.handle().pipe(
            // The completion write is AWAITED before the response is returned,
            // not fired and forgotten: a sequential replay must find the row
            // already marked complete, or it would see the claim still in
            // progress and wrongly answer 409.
            switchMap((result) =>
              from(this.complete(orgId, key, res.statusCode ?? 200, result)).pipe(
                map(() => result),
              ),
            ),
            catchError((err) =>
              // Release the claim so a corrected retry with the same key can
              // proceed; a failure is not a result worth replaying.
              from(this.release(orgId, key)).pipe(switchMap(() => throwError(() => err))),
            ),
          );
        }

        // Lost the insert — a row already exists for this key.
        return from(this.existing(orgId, key)).pipe(
          switchMap((row) => {
            if (!row) {
              // The holder released its claim between our failed insert and
              // this read (its handler errored). Treat the key as free again.
              return next.handle().pipe(
                switchMap((result) =>
                  from(this.complete(orgId, key, res.statusCode ?? 200, result)).pipe(
                    map(() => result),
                  ),
                ),
              );
            }
            if (row.request_hash !== requestHash) {
              return throwError(() =>
                new AppException(
                  ErrorCode.CONFLICT,
                  'This Idempotency-Key was already used for a different request.',
                  HttpStatus.CONFLICT,
                ),
              );
            }
            if (row.in_progress) {
              return throwError(() =>
                new AppException(
                  ErrorCode.CONFLICT,
                  'A request with this Idempotency-Key is still being processed.',
                  HttpStatus.CONFLICT,
                ),
              );
            }
            res.status(row.response_status ?? 200);
            return of(row.response_body ?? null);
          }),
        );
      }),
    );
  }

  /**
   * Try to claim the key. `won` means we inserted the row and own execution;
   * `lost` means a row already existed.
   */
  private async claim(
    orgId: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<'won' | 'lost'> {
    const { rowCount } = await this.db.query(
      `INSERT INTO idempotency_keys
         (organization_id, idempotency_key, request_method, request_path, request_hash, in_progress)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [orgId, key, method, path, requestHash],
    );
    return rowCount === 1 ? 'won' : 'lost';
  }

  private async complete(
    orgId: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await this.db
      .query(
        `UPDATE idempotency_keys
            SET response_status = $3, response_body = $4::jsonb,
                in_progress = false, completed_at = now()
          WHERE organization_id = $1 AND idempotency_key = $2`,
        [orgId, key, status, JSON.stringify(body ?? null)],
      )
      .catch(() => undefined);
  }

  private async release(orgId: string, key: string): Promise<void> {
    await this.db
      .query(
        `DELETE FROM idempotency_keys
          WHERE organization_id = $1 AND idempotency_key = $2 AND in_progress = true`,
        [orgId, key],
      )
      .catch(() => undefined);
  }

  private async existing(orgId: string, key: string): Promise<IdempotencyRow | null> {
    return this.db.queryOne<IdempotencyRow>(
      `SELECT request_hash, response_status, response_body, in_progress
         FROM idempotency_keys
        WHERE organization_id = $1 AND idempotency_key = $2`,
      [orgId, key],
    );
  }
}

interface IdempotencyRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  in_progress: boolean;
}

/** A header can arrive as string | string[]; only a lone, non-empty value counts. */
function headerValue(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A stable fingerprint of the request a key was first used for. Keys are
 * sorted so that logically identical bodies with different property order
 * hash the same — the client should not be punished for JSON key ordering.
 */
function hashRequest(method: string, path: string, body: unknown): string {
  const canonical = `${method} ${path}\n${stableStringify(body ?? null)}`;
  return createHash('sha256').update(canonical).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}
