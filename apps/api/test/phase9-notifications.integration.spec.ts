import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/configuration';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

/**
 * Phase 9 — the bilingual notification engine, live (D-21, ZM-NOT-004,
 * ZM-I18N-003).
 *
 * The seed populated `notification_templates` EN + AR and D-21 routed every
 * sender through `NotificationsService.send()`. What has to be proved against
 * the real database is the selection chain end to end: the recipient's
 * `preferred_language` — not a header, not a default — picks the template
 * row; the placeholders render from the sender's variables; the version used
 * is written onto the notification; and where no row matches, the sender's
 * literal text goes out unchanged (the degrade direction that keeps a
 * missing template from ever suppressing a message).
 *
 * The Arabic body asserted here is the constrained one on purpose:
 * `PAYMENT_OVERDUE_UNCONFIRMED` must not assert non-payment in any language,
 * and a translation that drifted into an accusation would pass every EN test
 * in the repository.
 */

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const AL_NOOR_OWNER = '0e100000-0000-4000-8000-000000000001';

describeIfDb('Phase 9 — bilingual notification rendering', () => {
  let app: INestApplication;
  let db: Client;
  let notifications: NotificationsService;
  const cleanupIds: string[] = [];
  let originalLanguage: string;

  const sendOverdue = async () =>
    notifications.send({
      templateKey: 'PAYMENT_OVERDUE_UNCONFIRMED',
      recipientUserId: AL_NOOR_OWNER,
      transactionId: null,
      fallbackSubject: 'fallback subject — a template row must beat this',
      fallbackBody: 'fallback body — a template row must beat this',
      variables: { invoiceNumber: 'INV-AR-TEST-1', dueDate: '2026-08-01' },
    });

  beforeAll(async () => {
    db = new Client({
      connectionString,
      ssl: /supabase\.(com|co)/.test(connectionString!) ? { rejectUnauthorized: false } : undefined,
    });
    await db.connect();

    const { rows } = await db.query<{ preferred_language: string }>(
      `SELECT preferred_language FROM users WHERE id = $1`,
      [AL_NOOR_OWNER],
    );
    originalLanguage = rows[0].preferred_language;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    const config = app.get(AppConfig);
    app.setGlobalPrefix(config.globalPrefix, { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    notifications = app.get(NotificationsService);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db
        .query(`UPDATE users SET preferred_language = $2 WHERE id = $1`, [
          AL_NOOR_OWNER,
          originalLanguage,
        ])
        .catch(() => undefined);
      for (const id of cleanupIds) {
        await db.query(`DELETE FROM notifications WHERE id = $1`, [id]).catch(() => undefined);
      }
      await db.end();
    }
    await app?.close();
  }, 60_000);

  it('renders the Arabic template for an Arabic-preferring recipient, constraints intact', async () => {
    await db.query(`UPDATE users SET preferred_language = 'AR' WHERE id = $1`, [AL_NOOR_OWNER]);

    const row = await sendOverdue();
    cleanupIds.push(row.id);

    expect(row.language).toBe('AR');
    expect(row.template_version).toBe('1.0');
    // Rendered, not templated: the placeholder resolved and the machinery
    // never reaches the reader.
    expect(row.body).toContain('INV-AR-TEST-1');
    expect(row.body).not.toContain('{{');
    // The seeded Arabic wording, and its constraint carried across the
    // translation: waiting for the bank, asserting nothing about the buyer.
    expect(row.body).toContain('بانتظار تأكيد البنك');
    expect(row.body).not.toContain('تخلّف');
    // The fallback lost to the template.
    expect(row.body).not.toContain('fallback body');
    expect(row.subject).toBe('تجاوزت فاتورتك تاريخ استحقاقها');
  }, 60_000);

  it('renders the English template once the preference flips back', async () => {
    await db.query(`UPDATE users SET preferred_language = 'EN' WHERE id = $1`, [AL_NOOR_OWNER]);

    const row = await sendOverdue();
    cleanupIds.push(row.id);

    expect(row.language).toBe('EN');
    expect(row.body).toContain('INV-AR-TEST-1');
    expect(row.body).toContain('not a record of non-payment');
    expect(row.body.toLowerCase()).not.toContain('default');
  }, 60_000);

  it('degrades to the caller\'s literal text when no template row exists', async () => {
    const key = `NO_SUCH_TEMPLATE_${randomUUID().slice(0, 8).toUpperCase()}`;
    const row = await notifications.send({
      templateKey: key,
      recipientUserId: AL_NOOR_OWNER,
      transactionId: null,
      fallbackSubject: 'the literal subject',
      fallbackBody: 'the literal body — this must go out unchanged',
    });
    cleanupIds.push(row.id);

    expect(row.template_version).toBeNull();
    expect(row.subject).toBe('the literal subject');
    expect(row.body).toBe('the literal body — this must go out unchanged');
    // Degraded, not suppressed: the message still went out.
    expect(row.status).toBe('SENT');
  }, 60_000);
});
