import { Injectable, LoggerService, Scope } from '@nestjs/common';
import { RequestContextStore } from '../context/request-context';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON logging.
 *
 * One JSON object per line, so hosted log search can filter by
 * correlationId, actorOrgId, or path without regex-scraping prose. Every
 * line automatically carries the active request context, which is what makes
 * a production incident traceable from a single id the client was given.
 *
 * Redaction is applied on the way out rather than trusted at call sites:
 * tokens, keys, OTPs, and the supplier floor must never reach a log sink
 * (hard rules 3 and 8). A log line is a payload like any other.
 */
@Injectable({ scope: Scope.DEFAULT })
export class AppLogger implements LoggerService {
  private threshold: number = LEVEL_ORDER.info;

  setLevel(level: Level): void {
    this.threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }
  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack ? { stack } : undefined);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  /** Structured logging with arbitrary fields, redacted before emit. */
  event(level: Level, message: string, fields: Record<string, unknown>): void {
    this.write(level, message, undefined, fields);
  }

  private write(
    level: Level,
    message: unknown,
    context?: string,
    extra?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < this.threshold) return;

    const ctx = RequestContextStore.get();
    const line = {
      // The wall clock is correct here: a log timestamp records when the
      // line was emitted in the real world, not in demo time.
      ts: new Date().toISOString(),
      level,
      msg: typeof message === 'string' ? message : safeStringify(message),
      ...(context ? { context } : {}),
      ...(ctx
        ? {
            correlationId: ctx.correlationId,
            ...(ctx.userId ? { userId: ctx.userId } : {}),
            ...(ctx.organizationId ? { orgId: ctx.organizationId } : {}),
            ...(ctx.method && ctx.path ? { method: ctx.method, path: ctx.path } : {}),
          }
        : {}),
      ...(extra ? redact(extra) : {}),
    };

    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
  }
}

/**
 * Keys whose values never appear in a log line.
 *
 * `minimumAcceptableAmount` is here because hard rule 3 covers "logs shipped
 * to clients", and because a floor value in a log is one support-tool query
 * away from being a floor value on a screen.
 */
const REDACTED_KEYS = new Set(
  [
    'password',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'apiKey',
    'serviceRoleKey',
    'anonKey',
    'jwtSecret',
    'otp',
    'otpHash',
    'otp_hash',
    'iban',
    'ibanEnc',
    'nationalId',
    'nationalIdEnc',
    'minimumAcceptableAmount',
    'minimum_acceptable_amount',
    'bankInternalNotes',
    'bank_internal_notes',
  ].map((k) => k.toLowerCase()),
);

function redact(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 6) return { truncated: true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redact(value as Record<string, unknown>, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
