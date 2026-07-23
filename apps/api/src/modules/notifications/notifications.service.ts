import { Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { AuditService } from '../../common/audit/audit.service';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import {
  DeliveryResult,
  NOTIFICATION_CHANNELS,
  NotificationChannel,
  NotificationChannelAdapter,
} from './notification.channel';
import { languageFor, latestVersion, render, TemplateVariables } from './template-render';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * The notification engine (ZM-NOT-001..010).
 *
 * Every message the platform sends passes through here, which is the point:
 * `ZM-NOT-008` requires evidence of what was sent, to whom, when, and what the
 * gateway said about it. Scattered `INSERT INTO notifications` calls produce
 * messages; a single pipeline produces messages *with an evidence trail*.
 *
 * ## What "delivered" is allowed to mean
 *
 * The dummy gateways mark `SENT`, never `DELIVERED`. Handing a message to an
 * email provider is not the same as it reaching a person, and a system that
 * recorded delivery it could not observe would be manufacturing evidence — the
 * exact thing this table exists to prevent. `DELIVERED` is written only where
 * the platform can actually see it happen: an in-platform notification the
 * user opened, recorded by `markRead`.
 *
 * ## Templates, versions and languages
 *
 * Templates live in `notification_templates`, keyed by
 * `(template_key, channel, language, version)`. The version used is stored on
 * every notification row, so a message can always be reconstructed as it was
 * sent even after the template is edited. Where no template exists the caller's
 * literal subject and body are used — Phase 8's services pass real text, and a
 * missing template must degrade to "the message went out" rather than
 * "nothing was sent".
 */

export interface NotificationRow {
  id: string;
  template_key: string;
  template_version: string | null;
  channel: NotificationChannel;
  language: string;
  recipient_user_id: string | null;
  destination: string;
  subject: string | null;
  body: string;
  status: string;
  provider_reference: string | null;
  failure_reason: string | null;
  manual_call_notes: string | null;
  manual_call_by: string | null;
  transaction_id: string | null;
  queued_at: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
}

export interface SendRequest {
  templateKey: string;
  channel?: NotificationChannel;
  recipientUserId: string;
  transactionId?: string | null;
  /** Used when no template row matches — Phase 8's services pass real text. */
  fallbackSubject: string;
  fallbackBody: string;
  variables?: TemplateVariables;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
    @Inject(NOTIFICATION_CHANNELS)
    private readonly channels: NotificationChannelAdapter[],
  ) {}

  /**
   * Renders, stores and dispatches one notification, recording the outcome.
   *
   * Takes an optional client so a notification can commit inside the same
   * transaction as the thing it describes — a funding confirmation and the
   * message announcing it should not be able to disagree about whether they
   * happened.
   */
  async send(request: SendRequest, client?: PoolClient): Promise<NotificationRow> {
    const now = this.time.now();
    const channel = request.channel ?? 'IN_PLATFORM';
    const db = client ?? (this.db as unknown as PoolClient);

    const recipient = await this.recipient(db, request.recipientUserId);
    const language = languageFor(recipient?.language);
    const template = await this.template(db, request.templateKey, channel, language);

    const subject = template?.subject
      ? render(template.subject, request.variables ?? {}).text
      : request.fallbackSubject;
    const rendered = template
      ? render(template.body_template, request.variables ?? {})
      : { text: request.fallbackBody, missing: [] as string[] };

    if (rendered.missing.length > 0) {
      // Logged, not thrown: a template with a stale variable name should send
      // a slightly thin message, not block a funding confirmation.
      this.logger.warn(
        `Template ${request.templateKey}/${channel}/${language} referenced unknown ` +
          `variables: ${rendered.missing.join(', ')}`,
      );
    }

    const destination = this.destinationFor(channel, recipient);

    const { rows } = await db.query<NotificationRow>(
      `INSERT INTO notifications
         (template_key, template_version, channel, language, recipient_user_id, destination,
          subject, body, status, transaction_id, queued_at)
       VALUES ($1,$2,$3::notification_channel,$4::language_code,$5::uuid,$6,$7,$8,
               'QUEUED',$9::uuid,$10)
       RETURNING *`,
      [
        request.templateKey,
        template?.version ?? null,
        channel,
        language,
        request.recipientUserId,
        destination,
        subject,
        rendered.text,
        request.transactionId ?? null,
        now,
      ],
    );
    const notification = rows[0];

    const result = await this.dispatch(channel, {
      notificationId: notification.id,
      destination,
      subject,
      body: rendered.text,
      language,
    });

    return this.recordDelivery(db, notification.id, result, now);
  }

  /**
   * The user's in-platform inbox.
   *
   * Scoped to the caller — `recipient_user_id = me` — and nothing else. A
   * notification is addressed to a person, not to an organization, so there is
   * no org filter here and no way to read a colleague's messages.
   */
  async list(
    ctx: ActorContext,
    filters: { unread?: boolean; page: number; pageSize: number },
  ): Promise<Record<string, unknown>> {
    const conditions = [`recipient_user_id = $1`, `channel = 'IN_PLATFORM'`];
    const params: unknown[] = [ctx.userId];

    if (filters.unread) conditions.push(`delivered_at IS NULL`);
    const where = `WHERE ${conditions.join(' AND ')}`;

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications ${where}`,
      params,
    );
    const unreadRow = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications
        WHERE recipient_user_id = $1 AND channel = 'IN_PLATFORM' AND delivered_at IS NULL`,
      [ctx.userId],
    );

    params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const { rows } = await this.db.query<NotificationRow>(
      `SELECT * FROM notifications ${where}
        ORDER BY queued_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const total = Number(totalRow?.count ?? '0');
    return {
      items: rows.map(describeNotification),
      unreadCount: Number(unreadRow?.count ?? '0'),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize) || 1,
      },
    };
  }

  /**
   * The user opened it.
   *
   * This is the one place `DELIVERED` is legitimately written: for an
   * in-platform message, the user reading it *is* the delivery, and the
   * platform can actually observe that. Idempotent — the first read stands, so
   * a re-render of the inbox does not keep moving the timestamp.
   */
  async markRead(notificationId: string, ctx: ActorContext): Promise<NotificationRow> {
    const now = this.time.now();
    const { rows } = await this.db.query<NotificationRow>(
      `UPDATE notifications
          SET status = 'DELIVERED',
              delivered_at = COALESCE(delivered_at, $3::timestamptz)
        WHERE id = $1 AND recipient_user_id = $2::uuid
      RETURNING *`,
      [notificationId, ctx.userId, now],
    );
    // 404 rather than 403 for someone else's notification: the existence of a
    // message addressed to another user is not this caller's business.
    if (rows.length === 0) throw AppException.notFound('Notification');
    return rows[0];
  }

  /**
   * ZM-NOT-007 — record a call an operator actually made.
   *
   * The platform cannot place calls, so this does not pretend to. It records
   * that a human did, with their notes, through the same pipeline and the same
   * evidence fields as everything else.
   *
   * Reached by `POST /notifications/{id}/manual-call`, which is **additive**:
   * neither the frozen contract nor the v3.1.0 overlay declares a path for it,
   * because both declare storage for the manual-call record (ZM-NOT-007) and
   * no way to write it. Raised as Q-17 and ruled Option 1 by the product owner
   * on 2026-07-23. It is deliberately not folded into `read` — a recipient
   * opening their inbox and an operator attesting to a phone conversation are
   * different claims by different people, and one route would let the first
   * write the second.
   *
   * Audited with the previous notes in `previousValue`, and that is not
   * boilerplate. `manual_call_notes` is a single column, so a second operator
   * recording a later call overwrites the first one's account of what was
   * said — and this is the one field in the system whose entire content is a
   * human's unverifiable assertion about a conversation that happened offline.
   * Losing the earlier version silently would be a hard delete of evidence in a
   * system that forbids them (INV-7). The audit row keeps every superseded
   * version, attributed and timestamped.
   */
  async recordManualCall(
    notificationId: string,
    ctx: ActorContext,
    notes: string,
  ): Promise<NotificationRow> {
    const now = this.time.now();
    return this.db.transaction(async (client) => {
      const { rows: before } = await client.query<NotificationRow>(
        `SELECT * FROM notifications WHERE id = $1 AND channel = 'MANUAL_CALL' FOR UPDATE`,
        [notificationId],
      );
      if (before.length === 0) throw AppException.notFound('Notification');

      const { rows } = await client.query<NotificationRow>(
        `UPDATE notifications
            SET status = 'DELIVERED', manual_call_notes = $2, manual_call_by = $3::uuid,
                delivered_at = COALESCE(delivered_at, $4::timestamptz)
          WHERE id = $1 AND channel = 'MANUAL_CALL'
        RETURNING *`,
        [notificationId, notes, ctx.userId, now],
      );

      await this.audit.recordIn(client, {
        actionType: 'NOTIFICATION_MANUAL_CALL_RECORDED',
        targetEntityType: 'NOTIFICATION',
        targetEntityId: notificationId,
        previousValue: {
          manualCallNotes: before[0].manual_call_notes,
          manualCallBy: before[0].manual_call_by,
          status: before[0].status,
        },
        newValue: {
          manualCallNotes: notes,
          manualCallBy: ctx.userId,
          status: 'DELIVERED',
        },
      });

      return rows[0];
    });
  }

  // ===================================================================
  // helpers
  // ===================================================================

  private async dispatch(
    channel: NotificationChannel,
    request: {
      notificationId: string;
      destination: string;
      subject: string | null;
      body: string;
      language: 'EN' | 'AR';
    },
  ): Promise<DeliveryResult> {
    const adapter = this.channels.find((c) => c.channel === channel);
    if (!adapter) {
      return { status: 'FAILED', providerReference: null, failureReason: 'NO_CHANNEL_ADAPTER' };
    }
    try {
      return await adapter.send(request);
    } catch (err) {
      // A gateway throwing is a delivery failure with a reason, not an
      // exception that loses the notification entirely.
      return {
        status: 'FAILED',
        providerReference: null,
        failureReason: err instanceof Error ? err.message.slice(0, 500) : 'UNKNOWN',
      };
    }
  }

  private async recordDelivery(
    db: PoolClient,
    notificationId: string,
    result: DeliveryResult,
    now: Date,
  ): Promise<NotificationRow> {
    const { rows } = await db.query<NotificationRow>(
      `UPDATE notifications
          SET status = $2::notification_status,
              provider_reference = $3,
              failure_reason = $4,
              sent_at = CASE WHEN $2 IN ('SENT','DELIVERED') THEN $5::timestamptz ELSE sent_at END
        WHERE id = $1
      RETURNING *`,
      [notificationId, result.status, result.providerReference, result.failureReason, now],
    );
    return rows[0];
  }

  private async recipient(
    db: PoolClient,
    userId: string,
  ): Promise<{ email: string; phone_number: string | null; language: string | null } | null> {
    const { rows } = await db.query<{
      email: string;
      phone_number: string | null;
      language: string | null;
    }>(
      // preferred_language, not language — the column ZM-I18N-003 defined.
      // This query had no caller until Phase 9 routed the senders through
      // send(), so the wrong name sat here unexecuted since Phase 8.
      `SELECT email, phone_number, preferred_language AS language FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  private destinationFor(
    channel: NotificationChannel,
    recipient: { email: string; phone_number: string | null } | null,
  ): string {
    if (channel === 'EMAIL') return recipient?.email ?? 'unknown';
    if (channel === 'WHATSAPP' || channel === 'MANUAL_CALL') {
      return recipient?.phone_number ?? 'unknown';
    }
    return 'in-platform';
  }

  private async template(
    db: PoolClient,
    templateKey: string,
    channel: NotificationChannel,
    language: 'EN' | 'AR',
  ): Promise<{ version: string; subject: string | null; body_template: string } | null> {
    const { rows } = await db.query<{
      version: string;
      subject: string | null;
      body_template: string;
    }>(
      `SELECT version, subject, body_template
         FROM notification_templates
        WHERE template_key = $1 AND channel = $2::notification_channel
          AND language = $3::language_code AND is_active = true`,
      [templateKey, channel, language],
    );
    if (rows.length === 0) return null;

    const newest = latestVersion(rows.map((r) => r.version));
    return rows.find((r) => r.version === newest) ?? rows[0];
  }
}

/**
 * Allow-list for the inbox.
 *
 * `destination` and `provider_reference` are deliberately absent: a user's
 * inbox is for reading messages, not for auditing the gateway that carried
 * them, and the destination can carry a personal phone number.
 */
export function describeNotification(row: NotificationRow): Record<string, unknown> {
  return {
    id: row.id,
    templateKey: row.template_key,
    subject: row.subject,
    body: row.body,
    transactionId: row.transaction_id,
    // For an in-platform message, delivery IS the user having opened it.
    read: row.delivered_at !== null,
    queuedAt: row.queued_at.toISOString(),
  };
}
