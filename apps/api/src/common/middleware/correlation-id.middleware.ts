import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { RequestContextStore } from '../context/request-context';

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Opens the per-request context and assigns a correlation id.
 *
 * Runs before everything else so that even a request rejected by the auth
 * guard is traceable: the id is echoed in the response header and in the
 * error envelope, so a user reporting "it said forbidden" hands over one
 * value that finds the exact request in the logs.
 *
 * An inbound X-Correlation-Id is honoured (so a trace spans Agent B's
 * frontend and this API) but only if it looks like a UUID — the value ends
 * up in audit_logs.correlation_id, which is a uuid column, and in log lines.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(CORRELATION_HEADER);
    const correlationId = isUuid(inbound) ? (inbound as string) : randomUUID();

    res.setHeader(CORRELATION_HEADER, correlationId);

    RequestContextStore.run(
      {
        correlationId,
        ipAddress: clientIp(req),
        userAgent: req.header('user-agent') ?? undefined,
        method: req.method,
        path: req.originalUrl?.split('?')[0],
      },
      () => next(),
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Behind Render/Vercel the socket address is the proxy, so the forwarded
 * chain's first entry is the real client. Used for audit rows and consent
 * records, where the schema stores an inet.
 */
function clientIp(req: Request): string | undefined {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? undefined;
}
