import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { plusDays } from '../../common/time/business-time';
import { AppException } from '../../common/errors/app.exception';
import {
  GOVERNMENT_ADAPTERS,
  GovSource,
  GovernmentAdapter,
  GovernmentLookupResult,
  dataAvailabilityOf,
  isSourceAvailable,
} from './government-adapter';

/**
 * Government lookups, snapshot persistence, and per-field provenance.
 *
 * Three requirements meet here:
 *   ZM-GOV-001/002 — every field carries where it came from and when.
 *   ZM-SON-004     — self-declared data never overwrites government data.
 *   Hard rule 7    — an unanswered source is recorded as unanswered, and
 *                    contributes nothing but a dip in data availability.
 */

/** Snapshots are considered fresh for 90 days (schema comment on valid_until). */
export const SNAPSHOT_VALIDITY_DAYS = 90;

export type SubjectType = 'ORGANIZATION' | 'BUYER' | 'INVOICE';

export interface GovernmentRequestRow {
  id: string;
  source: GovSource;
  lookup_key: string;
  subject_type: string;
  subject_id: string | null;
  status: string;
  source_available: boolean;
  requested_at: Date;
  responded_at: Date | null;
  error_code: string | null;
  adapter_version: string | null;
}

@Injectable()
export class GovernmentService {
  private readonly logger = new Logger(GovernmentService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
    @Inject(GOVERNMENT_ADAPTERS) private readonly adapters: readonly GovernmentAdapter[],
  ) {}

  private adapterFor(source: GovSource): GovernmentAdapter {
    const adapter = this.adapters.find((a) => a.source === source);
    if (!adapter) {
      throw AppException.validation(`No adapter is configured for source ${source}.`, { source });
    }
    return adapter;
  }

  /**
   * Perform a lookup and persist everything about it.
   *
   * The request row is written *before* the call and updated after, so a
   * crash mid-lookup leaves a PENDING row rather than no evidence that the
   * platform ever asked. `source_available` is derived from the adapter's
   * result union, never passed in by a caller.
   */
  async lookup(params: {
    source: GovSource;
    lookupKey: string;
    subjectType: SubjectType;
    subjectId: string | null;
  }): Promise<{ request: GovernmentRequestRow; result: GovernmentLookupResult }> {
    const adapter = this.adapterFor(params.source);

    const created = await this.db.queryOne<{ id: string }>(
      `INSERT INTO government_verification_requests
         (source, lookup_key, subject_type, subject_id, status, source_available, requested_at, adapter_version)
       VALUES ($1, $2, $3, $4, 'PENDING', true, $5, $6)
       RETURNING id`,
      [
        params.source,
        params.lookupKey,
        params.subjectType,
        params.subjectId,
        this.time.now(),
        adapter.version,
      ],
    );
    if (!created) throw new Error('Failed to create a government verification request.');

    const result = await adapter.lookup(params.lookupKey);
    const available = isSourceAvailable(result);

    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE government_verification_requests
            SET status = $2, source_available = $3, responded_at = $4, error_code = $5
          WHERE id = $1`,
        [
          created.id,
          result.status,
          available,
          this.time.now(),
          result.kind === 'UNANSWERED' ? result.errorCode : null,
        ],
      );

      // Only an answered source produces a snapshot. There is deliberately
      // no row to record for an outage beyond the request itself: an empty
      // snapshot would be indistinguishable from a registry that answered
      // with nothing, which is the confusion hard rule 7 forbids.
      if (result.kind === 'ANSWERED') {
        const snapshotId = await this.persistSnapshot(client, created.id, params.source, result);
        if (params.subjectId && result.status !== 'NOT_FOUND') {
          await this.persistFieldProvenance(
            client,
            params.subjectType,
            params.subjectId,
            params.source,
            snapshotId,
            result.normalized,
          );
        }
      }
    });

    if (!available) {
      this.logger.warn(
        `${params.source} unavailable for ${params.lookupKey}: ${
          result.kind === 'UNANSWERED' ? result.errorCode : 'unknown'
        }. Recorded as unavailable — not as an adverse finding.`,
      );
    }

    const request = await this.getRequest(created.id);
    if (!request) throw new Error('The government request vanished immediately after creation.');
    return { request, result };
  }

  /**
   * Persist the raw and normalized payloads with a content hash.
   *
   * The hash is over the *raw* payload, canonicalized by key order, so the
   * same registry answer hashes identically across runs and a later
   * re-fetch can be compared against it. Hashing the normalized form would
   * make the hash change whenever our own mapping changes, which defeats
   * the purpose.
   */
  private async persistSnapshot(
    client: PoolClient,
    requestId: string,
    source: GovSource,
    result: Extract<GovernmentLookupResult, { kind: 'ANSWERED' }>,
  ): Promise<string> {
    const retrievedAt = this.time.now();
    const payloadHash = createHash('sha256').update(canonicalJson(result.raw)).digest('hex');

    const row = await client.query<{ id: string }>(
      `INSERT INTO government_data_snapshots
         (request_id, source, raw_payload, normalized_payload, payload_hash, retrieved_at, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        requestId,
        source,
        JSON.stringify(result.raw),
        JSON.stringify(result.normalized),
        payloadHash,
        retrievedAt,
        plusDays(retrievedAt, SNAPSHOT_VALIDITY_DAYS),
      ],
    );
    return row.rows[0].id;
  }

  /**
   * Write one provenance row per field (ZM-GOV-002).
   *
   * Previous GOVERNMENT values for the same field are superseded rather
   * than updated: the history of what the registry said, and when, is the
   * evidence a dispute is settled with. Self-declared rows are left alone —
   * they are superseded by nothing, because they were never authoritative
   * for a field the government answers.
   */
  private async persistFieldProvenance(
    client: PoolClient,
    entityType: SubjectType,
    entityId: string,
    source: GovSource,
    snapshotId: string,
    normalized: Record<string, string>,
  ): Promise<void> {
    const retrievedAt = this.time.now();
    for (const [fieldKey, fieldValue] of Object.entries(normalized)) {
      await client.query(
        `UPDATE entity_field_values
            SET superseded_at = $4
          WHERE entity_type = $1 AND entity_id = $2 AND field_key = $3
            AND source_kind = 'GOVERNMENT' AND superseded_at IS NULL`,
        [entityType, entityId, fieldKey, retrievedAt],
      );
      await client.query(
        `INSERT INTO entity_field_values
           (entity_type, entity_id, field_key, field_value, source_kind, source,
            snapshot_id, verification_status, retrieved_at)
         VALUES ($1, $2, $3, $4, 'GOVERNMENT', $5, $6, 'VERIFIED', $7)
         ON CONFLICT (entity_type, entity_id, field_key, source_kind, retrieved_at) DO NOTHING`,
        [entityType, entityId, fieldKey, fieldValue, source, snapshotId, retrievedAt],
      );
    }
  }

  /**
   * Record a value the supplier typed in.
   *
   * ZM-SON-004: this can never displace a government value. The row is
   * still written — losing what the user entered would be its own defect,
   * and a mismatch between the two is exactly what a reviewer needs to see
   * — but `effectiveFields()` resolves GOVERNMENT ahead of SELF_DECLARED,
   * so the government answer stays the one the platform acts on.
   */
  async recordSelfDeclared(
    entityType: SubjectType,
    entityId: string,
    fields: Record<string, string>,
    client?: PoolClient,
  ): Promise<{ accepted: string[]; shadowedByGovernment: string[] }> {
    const run = async (c: PoolClient): Promise<{ accepted: string[]; shadowedByGovernment: string[] }> => {
      const accepted: string[] = [];
      const shadowed: string[] = [];
      const retrievedAt = this.time.now();

      for (const [fieldKey, fieldValue] of Object.entries(fields)) {
        const existing = await c.query(
          `SELECT 1 FROM entity_field_values
            WHERE entity_type = $1 AND entity_id = $2 AND field_key = $3
              AND source_kind = 'GOVERNMENT' AND superseded_at IS NULL
            LIMIT 1`,
          [entityType, entityId, fieldKey],
        );
        const hasGovernment = existing.rows.length > 0;

        await c.query(
          `UPDATE entity_field_values
              SET superseded_at = $4
            WHERE entity_type = $1 AND entity_id = $2 AND field_key = $3
              AND source_kind = 'SELF_DECLARED' AND superseded_at IS NULL`,
          [entityType, entityId, fieldKey, retrievedAt],
        );
        await c.query(
          `INSERT INTO entity_field_values
             (entity_type, entity_id, field_key, field_value, source_kind,
              verification_status, retrieved_at)
           VALUES ($1, $2, $3, $4, 'SELF_DECLARED', $5, $6)
           ON CONFLICT (entity_type, entity_id, field_key, source_kind, retrieved_at) DO NOTHING`,
          [
            entityType,
            entityId,
            fieldKey,
            fieldValue,
            // A self-declared value that contradicts a government one is
            // flagged for the reviewer rather than silently accepted.
            hasGovernment ? 'MISMATCH' : 'UNVERIFIED',
            retrievedAt,
          ],
        );

        if (hasGovernment) shadowed.push(fieldKey);
        else accepted.push(fieldKey);
      }
      return { accepted, shadowedByGovernment: shadowed };
    };

    // Always transactional: the supersede-then-insert pair must not be
    // interruptible, or a field ends up with two live self-declared rows.
    return client ? run(client) : this.db.transaction(run);
  }

  /**
   * The effective value of every field for an entity, with provenance.
   *
   * GOVERNMENT wins over SELF_DECLARED for the same field key — ZM-SON-004
   * expressed as a query rather than as a rule someone has to remember.
   */
  async effectiveFields(
    entityType: SubjectType,
    entityId: string,
  ): Promise<Record<string, { value: string | null; sourceKind: string; source: string | null; retrievedAt: Date }>> {
    const { rows } = await this.db.query<{
      field_key: string;
      field_value: string | null;
      source_kind: string;
      source: string | null;
      retrieved_at: Date;
    }>(
      `SELECT DISTINCT ON (field_key)
              field_key, field_value, source_kind, source, retrieved_at
         FROM entity_field_values
        WHERE entity_type = $1 AND entity_id = $2 AND superseded_at IS NULL
        ORDER BY field_key,
                 CASE source_kind WHEN 'GOVERNMENT' THEN 0 WHEN 'DERIVED' THEN 1 ELSE 2 END,
                 retrieved_at DESC`,
      [entityType, entityId],
    );

    const out: Record<string, { value: string | null; sourceKind: string; source: string | null; retrievedAt: Date }> = {};
    for (const row of rows) {
      out[row.field_key] = {
        value: row.field_value,
        sourceKind: row.source_kind,
        source: row.source,
        retrievedAt: row.retrieved_at,
      };
    }
    return out;
  }

  /**
   * The latest request per source for a subject (Q-08): what the
   * application detail's per-source panel renders. Latest only — a re-query
   * supersedes its predecessor for display, while every row stays in the
   * table for audit.
   */
  async listRequestsForSubject(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<(GovernmentRequestRow & { valid_until: Date | null })[]> {
    const { rows } = await this.db.query<GovernmentRequestRow & { valid_until: Date | null }>(
      `SELECT DISTINCT ON (r.source)
              r.id, r.source, r.lookup_key, r.subject_type, r.subject_id, r.status,
              r.source_available, r.requested_at, r.responded_at, r.error_code,
              r.adapter_version, s.valid_until
         FROM government_verification_requests r
         LEFT JOIN government_data_snapshots s ON s.request_id = r.id
        WHERE r.subject_type = $1 AND r.subject_id = $2
        ORDER BY r.source, r.requested_at DESC`,
      [subjectType, subjectId],
    );
    return rows;
  }

  /** The establishment number an organization is registered under, for ownership checks. */
  async establishmentNumberOf(organizationId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ national_establishment_no: string | null }>(
      `SELECT national_establishment_no FROM organizations WHERE id = $1`,
      [organizationId],
    );
    return row?.national_establishment_no ?? null;
  }

  async getRequest(id: string): Promise<GovernmentRequestRow | null> {
    return this.db.queryOne<GovernmentRequestRow>(
      `SELECT id, source, lookup_key, subject_type, subject_id, status,
              source_available, requested_at, responded_at, error_code, adapter_version
         FROM government_verification_requests
        WHERE id = $1`,
      [id],
    );
  }

  /** The snapshot belonging to a request, if it produced one. */
  async snapshotOf(requestId: string): Promise<{
    normalized_payload: Record<string, string>;
    retrieved_at: Date;
    valid_until: Date;
    payload_hash: string;
  } | null> {
    return this.db.queryOne(
      `SELECT normalized_payload, retrieved_at, valid_until, payload_hash
         FROM government_data_snapshots
        WHERE request_id = $1
        ORDER BY retrieved_at DESC
        LIMIT 1`,
      [requestId],
    );
  }

  /**
   * Run every source for a subject and summarize.
   *
   * `dataAvailabilityPct` is the mean per-source availability. Note what is
   * NOT here: no risk component, no score, no penalty. An unavailable
   * source moves this number and nothing else, which is INV-9 stated as
   * code rather than as a comment.
   */
  async lookupAll(
    lookupKey: string,
    subjectType: SubjectType,
    subjectId: string | null,
    sources: readonly GovSource[] = ['CCD', 'ISTD', 'GAM'],
  ): Promise<{
    results: { source: GovSource; request: GovernmentRequestRow; result: GovernmentLookupResult }[];
    dataAvailabilityPct: number;
    anySourceUnavailable: boolean;
  }> {
    const results: { source: GovSource; request: GovernmentRequestRow; result: GovernmentLookupResult }[] = [];
    for (const source of sources) {
      const { request, result } = await this.lookup({ source, lookupKey, subjectType, subjectId });
      results.push({ source, request, result });
    }

    const availability =
      results.reduce((sum, r) => sum + dataAvailabilityOf(r.result), 0) / (results.length || 1);

    return {
      results,
      // Rounded to a whole percent for display. Money rounding rules do not
      // apply — this is not money and never becomes money.
      dataAvailabilityPct: Math.floor(availability * 100),
      anySourceUnavailable: results.some((r) => !isSourceAvailable(r.result)),
    };
  }
}

/** Stable key ordering so the same payload always hashes the same. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
