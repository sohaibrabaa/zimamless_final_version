import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RequestContextStore } from '../context/request-context';
import { AppLogger } from '../logging/app-logger.service';
import { PoolClient } from 'pg';

export interface AuditEntry {
  actionType: string;
  targetEntityType: string;
  targetEntityId?: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}

/**
 * Writes audit_logs rows.
 *
 * Hard rule 6: every mutation writes an audit entry with actor user, actor
 * org (the ACTIVE context, not "the user's org" — a multi-org user acting
 * for one principal must not be recorded against another), before/after
 * values, and the correlation id.
 *
 * The table is append-only at the database level: the frozen schema installs
 * RULEs turning UPDATE and DELETE on audit_logs into no-ops, so a bug here
 * cannot rewrite history, only fail to add to it.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Record inside a caller's transaction.
   *
   * Preferred for domain mutations: passing the same client makes the audit
   * row commit or roll back with the change it describes. An audit trail
   * that survives a rolled-back mutation is worse than none, because it
   * asserts something that never happened.
   */
  async recordIn(client: PoolClient, entry: AuditEntry): Promise<void> {
    const ctx = RequestContextStore.get();
    await client.query(
      `INSERT INTO audit_logs
         (actor_user_id, actor_org_id, action_type, target_entity_type, target_entity_id,
          previous_value, new_value, ip_address, device_info, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ctx?.userId ?? null,
        ctx?.organizationId ?? null,
        entry.actionType,
        entry.targetEntityType,
        entry.targetEntityId ?? null,
        entry.previousValue ? JSON.stringify(redactSensitive(entry.previousValue)) : null,
        entry.newValue ? JSON.stringify(redactSensitive(entry.newValue)) : null,
        ctx?.ipAddress ?? null,
        ctx?.userAgent ?? null,
        ctx?.correlationId ?? null,
      ],
    );
  }

  /**
   * Record outside any transaction.
   *
   * A failure here is logged but never propagated: the audit write must not
   * turn an otherwise successful request into a 500 after the fact. The
   * transactional variant above is what guarantees coverage for domain
   * mutations; this is for the interceptor's catch-all sweep.
   */
  async record(entry: AuditEntry): Promise<void> {
    const ctx = RequestContextStore.get();
    try {
      await this.db.query(
        `INSERT INTO audit_logs
           (actor_user_id, actor_org_id, action_type, target_entity_type, target_entity_id,
            previous_value, new_value, ip_address, device_info, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ctx?.userId ?? null,
          ctx?.organizationId ?? null,
          entry.actionType,
          entry.targetEntityType,
          entry.targetEntityId ?? null,
          entry.previousValue ? JSON.stringify(redactSensitive(entry.previousValue)) : null,
          entry.newValue ? JSON.stringify(redactSensitive(entry.newValue)) : null,
          ctx?.ipAddress ?? null,
          ctx?.userAgent ?? null,
          ctx?.correlationId ?? null,
        ],
      );
    } catch (err) {
      this.logger.event('error', 'Failed to write audit entry', {
        actionType: entry.actionType,
        targetEntityType: entry.targetEntityType,
        error: (err as Error).message,
      });
    }
  }
}

/**
 * audit_logs is readable by an organization's own users (policy audit_read),
 * so before/after snapshots are scrubbed of values that must not travel to a
 * counterparty — above all the supplier's floor (INV-8), which would
 * otherwise be captured verbatim by any update to a transaction row.
 */
const SENSITIVE_KEYS = new Set(
  [
    'minimumAcceptableAmount',
    'minimum_acceptable_amount',
    'otp',
    'otpHash',
    'otp_hash',
    'iban',
    'ibanEnc',
    'iban_enc',
    'nationalIdEnc',
    'national_id_enc',
    'password',
    'token',
    'bankInternalNotes',
    'bank_internal_notes',
  ].map((k) => k.toLowerCase()),
);

function redactSensitive(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 6) return { truncated: true };
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      // Recorded as changed without recording the value: the fact of the
      // change is auditable, the secret is not disclosed.
      out[key] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = redactSensitive(v as Record<string, unknown>, depth + 1);
    } else {
      out[key] = v;
    }
  }
  return out;
}
