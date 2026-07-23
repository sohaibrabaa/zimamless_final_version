import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';
import { RequestContextStore } from '../context/request-context';
import { AppLogger } from '../logging/app-logger.service';

/**
 * Every error leaves the API in the contract's Error shape:
 *
 *   { code, message, details?, correlationId? }
 *
 * Nothing else. Nest's default error body ({ statusCode, message, error })
 * would break Agent B's generated client, so this filter is registered
 * globally and is the only writer of error responses.
 *
 * Unexpected exceptions are logged in full and reported as a bare
 * INTERNAL_ERROR with the correlation id: stack traces, driver messages, and
 * SQL text must not reach a client, least of all a bank-facing one where a
 * leaked query could carry the supplier's floor (contract rule 2, INV-8).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = RequestContextStore.correlationId();

    const { status, body, logLevel, internal } = this.describe(exception);

    this.logger.event(logLevel, `${body.code}: ${body.message}`, {
      status,
      ...(internal ? { internal } : {}),
    });

    if (correlationId) body.correlationId = correlationId;

    // Errors are never cached: a 403 from a missing org context becomes a
    // 200 the moment the header is supplied.
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(body);
  }

  private describe(exception: unknown): {
    status: number;
    body: { code: string; message: string; details?: Record<string, unknown>; correlationId?: string };
    logLevel: 'warn' | 'error';
    internal?: string;
  } {
    if (exception instanceof AppException) {
      const payload = exception.getResponse() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      return {
        status: exception.getStatus(),
        body: {
          code: payload.code,
          message: payload.message,
          ...(payload.details ? { details: payload.details } : {}),
          ...promotedFields(payload.details),
        },
        // Expected, handled outcomes are not errors in the operational
        // sense; a wall of ERROR lines for ordinary 403s hides real faults.
        logLevel: exception.getStatus() >= 500 ? 'error' : 'warn',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      return {
        status,
        body: {
          code: this.codeForStatus(status),
          message: extractMessage(raw) ?? exception.message,
          ...(isValidationPayload(raw) ? { details: { violations: raw.message } } : {}),
        },
        logLevel: status >= 500 ? 'error' : 'warn',
      };
    }

    const err = exception as Error;
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred. Quote the correlation id when reporting this.',
      },
      logLevel: 'error',
      // Full detail goes to the log, never to the response.
      internal: err?.stack ?? String(exception),
    };
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        // Deliberately neutral: the specific context/role codes are thrown by
        // AppException, which never reaches this fallback. Guessing
        // ORGANIZATION_CONTEXT_REQUIRED here would mislabel every unrelated
        // ForbiddenException the codebase grows later.
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}

function extractMessage(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const m = (raw as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return 'Request validation failed.';
  }
  return undefined;
}

function isValidationPayload(raw: unknown): raw is { message: string[] } {
  return (
    !!raw &&
    typeof raw === 'object' &&
    'message' in raw &&
    Array.isArray((raw as { message: unknown }).message)
  );
}

/**
 * Fields the contract declares at the top level of an error body.
 *
 * The Error envelope puts everything situational under `details`, and that is
 * right for almost every failure. `POST /transactions/{id}/funding/confirm`
 * is the exception: its 401 is declared with an inline schema of
 * `{ code, attemptsRemaining }` — not a `$ref` to Error — so a client reading
 * the contract expects `attemptsRemaining` beside `code`, not nested.
 *
 * Rather than special-case one endpoint in the filter, one named field is
 * promoted wherever it appears. It stays in `details` too, so nothing that
 * reads the envelope shape breaks. The list is deliberately closed: adding to
 * it means the contract declares another top-level field, not that it would
 * be convenient.
 */
const PROMOTED_TO_TOP_LEVEL = ['attemptsRemaining'] as const;

function promotedFields(details?: Record<string, unknown>): Record<string, unknown> {
  if (!details) return {};
  const promoted: Record<string, unknown> = {};
  for (const field of PROMOTED_TO_TOP_LEVEL) {
    if (details[field] !== undefined) promoted[field] = details[field];
  }
  return promoted;
}
