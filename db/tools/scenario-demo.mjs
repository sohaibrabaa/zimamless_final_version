#!/usr/bin/env node
/**
 * Phase 9 demo seed (ZM-DEMO-001/002) — the full demo path, staged.
 *
 *   node db/tools/scenario-demo.mjs           create / heal the demo population
 *   node db/tools/scenario-demo.mjs --status  report what is present
 *   node db/tools/scenario-demo.mjs --purge   remove what can be removed
 *
 * A judge should see a live system with history, not empty tables. This seed
 * stages one transaction at every demo-relevant state, with due dates
 * positioned so the time machine has something to move, and populates the
 * bilingual `notification_templates` catalogue so the render path — wired in
 * Phase 9 through NotificationsService.send() — serves real EN/AR rows.
 *
 * ## The doctrine (from scenario-phase5.mjs, unchanged)
 *
 * Anything that moves money or state goes through the API as the persona
 * entitled to perform it: acceptance snapshots, commissions, contracts,
 * settlements, ledger journals are *outcomes of code paths*, and hand-writing
 * them in SQL would stage a demo of rows the system never produced. What IS
 * staged directly is the inert pre-state (an ELIGIBLE transaction and its
 * invoice; an open listing with an approved offer, the Phase 7 fixture
 * pattern) — the route to those states is Phase 3/5/6's proven ground, not
 * what this demo demonstrates.
 *
 * One state is not even staged by the API: OVERDUE_UNCONFIRMED is written
 * only by the maturity sweep, so the two fixtures that need it are funded
 * with a past due date and this script *waits for the real sweep* to process
 * them. If the API's scheduler is off, the script says so and fails loudly
 * rather than writing the state by hand.
 *
 * Idempotent: each fixture has a fixed id in the 0e990000 block and every
 * step probes before acting, so a re-run heals rather than duplicates.
 *
 * Requires: migrations applied, db:seed run, and the API running with its
 * scheduler (npm run dev -w @zimmamless/api).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* environment-provided config (CI) */
}

const {
  DATABASE_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  NODE_ENV,
  SEED_USER_PASSWORD = 'Zimmamless#2026',
  API_BASE_URL = 'http://localhost:3000/v1',
} = process.env;

for (const [k, v] of Object.entries({ DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY })) {
  if (!v) {
    console.error(`FATAL: ${k} is not set.`);
    process.exit(1);
  }
}

if (NODE_ENV === 'production') {
  console.error('FATAL: refusing to run the demo seed with NODE_ENV=production.');
  process.exit(1);
}

const supabase = SUPABASE_URL.replace(/\/+$/, '');
const statusOnly = process.argv.includes('--status');
const purge = process.argv.includes('--purge');

// ---------------------------------------------------------------------------
// Canonical identities (db/seed/identities.mjs, 0100_seed_dev.sql)
// ---------------------------------------------------------------------------

const ORG = {
  platform: '0e000000-0000-4000-8000-000000000001',
  alNoor: '0e000000-0000-4000-8000-000000000002',
  bankA: '0e000000-0000-4000-8000-000000000004',
  bankB: '0e000000-0000-4000-8000-000000000005',
};
const AL_NOOR_OWNER = '0e100000-0000-4000-8000-000000000001';
const BANK_A_MAKER = '0e100000-0000-4000-8000-000000000005';
const BANK_A_APPROVER = '0e100000-0000-4000-8000-000000000006';
const BUYER_ESTABLISHMENT = '30000201'; // Amman Retail Group

const PERSONA = {
  supplier: 'owner@alnoor.zimmamless.test',
  bankAMaker: 'maker@jnb.zimmamless.test',
  bankAApprover: 'approver@jnb.zimmamless.test',
  bankAOps: 'ops@jnb.zimmamless.test',
  bankBMaker: 'maker@lcb.zimmamless.test',
  bankBApprover: 'approver@lcb.zimmamless.test',
  platformAdmin: 'admin@platform.zimmamless.test',
};
const PERSONA_ORG = {
  supplier: ORG.alNoor,
  bankAMaker: ORG.bankA,
  bankAApprover: ORG.bankA,
  bankAOps: ORG.bankA,
  bankBMaker: ORG.bankB,
  bankBApprover: ORG.bankB,
  platformAdmin: ORG.platform,
};

// ---------------------------------------------------------------------------
// Fixtures — the 0e990000 block, one slot per demo state
// ---------------------------------------------------------------------------
// The tier-1 numbers from the Phase 5 checkpoint, so every screen shows the
// arithmetic the demo script narrates: 11,600 outstanding, floor 8,000,
// bank A advances 9,000 gross → 8,390 net after 300 + 150 + 135 + 25.

const MONEY = {
  face: '11600.000',
  floor: '8000.000',
  gross: '9000.000',
  discount: '300.000',
  fees: '150.000',
  commission: '135.000',
  listingFee: '25.000',
  net: '8390.000',
};

// Last UUID group is exactly 12 hex chars: 8 zeros + slot digit + 3-digit n.
const fid = (slot, n) =>
  `0e990000-0000-4000-8000-00000000${slot}${String(n).padStart(3, '0')}`;

/**
 * dueInDays is what makes the population worth demoing: +5 gives the time
 * machine something to cross live on stage.
 *
 * Fixtures 6 and 7 need due dates in the *past* — but a receivable that has
 * already matured cannot be listed, accepted or contracted (the contract
 * generator refuses with INVOICE_PAST_DUE, correctly: it is no longer a
 * future receivable). So they are staged with due dates one day out, funded
 * while still legitimate, and then matured **through the demo time machine**
 * — the exact mechanism the live demo uses — with the clock returned to zero
 * before the date-sensitive fixtures are staged. Nothing hand-writes a state
 * and nothing backdates an invoice.
 */
const FIXTURES = [
  { n: 1, slot: 'DRAFT',                ref: 'ZM-DEMO-DRAFT',     dueInDays: null },
  { n: 2, slot: 'ELIGIBLE',             ref: 'ZM-DEMO-ELIGIBLE',  dueInDays: 60 },
  { n: 3, slot: 'OPEN_FOR_OFFERS',      ref: 'ZM-DEMO-OPEN',      dueInDays: 75 },
  { n: 4, slot: 'FUNDING_CONF_PENDING', ref: 'ZM-DEMO-FCP',       dueInDays: 45 },
  // Due +8, not +5: AS-08's 7-day minimum tenor is a hard blocker, and a
  // fixture staged inside it would (correctly) carry a blocked CRITICAL
  // score into every underwriting screen. Eight days clears the floor at
  // staging and still leaves the time machine a one-jump maturity story.
  // The first staging run used +5 under the id ...1005 (ref ZM-DEMO-FUNDED);
  // that chain is funded and permanent (INV-7) and stays as a second
  // maturing receivable.
  { n: 10, slot: 'FUNDED_NEAR_MATURITY', ref: 'ZM-DEMO-MATURING', dueInDays: 8 },
  { n: 6, slot: 'OVERDUE_UNCONFIRMED',  ref: 'ZM-DEMO-OVERDUE-U', dueInDays: 1 },
  { n: 7, slot: 'RECOURSE_ACTIVE',      ref: 'ZM-DEMO-RECOURSE',  dueInDays: 1 },
  { n: 8, slot: 'PAID',                 ref: 'ZM-DEMO-PAID',      dueInDays: 20 },
  { n: 9, slot: 'CANCELLED',            ref: 'ZM-DEMO-CANCELLED', dueInDays: 30 },
];
const txId = (f) => fid('1', f.n);
const invId = (f) => fid('2', f.n);
const listingId = (f) => fid('3', f.n);
const offerId = (f) => fid('4', f.n);

// ---------------------------------------------------------------------------
// The bilingual template catalogue (ZM-NOT-009, D-17: Western digits)
// ---------------------------------------------------------------------------
// Keys are the ones the senders actually pass — LISTING_AVAILABLE and
// OFFER_SELECTED are the code's names (the NOTIFICATIONS.md catalogue is
// aligned to these in Phase 9). Placeholders match each sender's `variables`.
//
// Two bodies carry constraints a rewrite must not break (both marked in
// NOTIFICATIONS.md): PAYMENT_OVERDUE_UNCONFIRMED asserts nothing about the
// buyer's conduct in either language, and OFFER_NOT_SELECTED carries nothing
// competitive — no placeholders at all, so no future edit can leak through
// one.

const TEMPLATES = [
  {
    key: 'LISTING_AVAILABLE',
    en: {
      subject: 'A new receivable is available',
      body: 'A receivable of {{outstandingAmount}} JOD is open for offers until {{offerDeadline}}.',
    },
    ar: {
      subject: 'ذمم مدينة جديدة متاحة',
      body: 'ذمم مدينة بقيمة {{outstandingAmount}} دينار أردني مفتوحة لتقديم العروض حتى {{offerDeadline}}.',
    },
  },
  {
    key: 'OFFER_RECEIVED',
    en: {
      subject: 'You have received a financing offer',
      body:
        'A bank has submitted an offer on your listed receivable. Review and compare your ' +
        'offers on the platform.',
    },
    ar: {
      subject: 'لقد استلمت عرض تمويل',
      body: 'قدّم أحد البنوك عرضاً على ذممك المدينة المدرجة. راجع عروضك وقارن بينها عبر المنصة.',
    },
  },
  {
    key: 'OFFER_SELECTED',
    en: {
      subject: 'Your offer has been accepted',
      body: 'The supplier has accepted your offer. The contract will be generated next.',
    },
    ar: {
      subject: 'تم قبول عرضكم',
      body: 'قبل المورّد عرضكم. سيتم إنشاء العقد في الخطوة التالية.',
    },
  },
  {
    key: 'OFFER_NOT_SELECTED',
    en: {
      subject: 'Your offer was not selected',
      body: 'The supplier has selected another offer for this receivable.',
    },
    ar: {
      subject: 'لم يتم اختيار عرضكم',
      body: 'اختار المورّد عرضاً آخر لهذه الذمم المدينة.',
    },
  },
  ...[50, 15].map((pct) => ({
    key: `SELECTION_REMINDER_${pct}`,
    en: {
      subject: 'Offer selection deadline approaching',
      body: 'About {{percentRemaining}}% of your selection window remains. It closes at {{selectionDeadline}}.',
    },
    ar: {
      subject: 'اقتراب الموعد النهائي لاختيار العرض',
      body: 'تبقّى نحو {{percentRemaining}}% من مهلة الاختيار. تُغلق في {{selectionDeadline}}.',
    },
  })),
  {
    key: 'FUNDING_MARKED_SENT',
    en: {
      subject: 'The bank has sent your funding',
      body:
        'The bank has recorded the transfer. To complete funding, confirm receipt with the ' +
        'one-time code the bank will provide to you directly.',
    },
    ar: {
      subject: 'قام البنك بإرسال التمويل',
      body:
        'سجّل البنك تنفيذ التحويل. لإتمام التمويل، أكّد الاستلام باستخدام الرمز لمرة واحدة ' +
        'الذي سيزوّدك به البنك مباشرة.',
    },
  },
  {
    key: 'FUNDING_CONFIRMATION_REMINDER',
    en: {
      subject: 'Please confirm you received your funding',
      body:
        'Your bank recorded this transfer as sent. Confirming receipt with the one-time code ' +
        'the bank gave you is what completes funding. If you have not received the code, ask ' +
        'the bank to issue a new one. After about {{windowHours}} hours without a confirmation ' +
        'this is escalated to platform operations.',
    },
    ar: {
      subject: 'يرجى تأكيد استلام التمويل',
      body:
        'سجّل بنكك هذا التحويل كمُرسَل. تأكيد الاستلام بالرمز لمرة واحدة الذي زوّدك به البنك ' +
        'هو ما يُتمّ التمويل. إذا لم تستلم الرمز، فاطلب من البنك إصدار رمز جديد. بعد نحو ' +
        '{{windowHours}} ساعة دون تأكيد يُصعَّد الأمر إلى عمليات المنصة.',
    },
  },
  {
    key: 'FUNDING_CONFIRMATION_ESCALATED',
    en: {
      subject: 'Funding confirmation stalled — operations action needed',
      body:
        'Invoice {{invoiceNumber}}: the bank marked the transfer sent at {{markedSentAt}} and ' +
        'the supplier has not confirmed receipt in {{hoursPending}} hours. Net payout ' +
        '{{netSupplierPayout}} JOD is held pending confirmation. The transaction is not FUNDED ' +
        'and the commission is not finalized. Contact the supplier, or have the bank reissue ' +
        'the one-time code.',
    },
    ar: {
      subject: 'تعثّر تأكيد التمويل — مطلوب إجراء من العمليات',
      body:
        'الفاتورة {{invoiceNumber}}: سجّل البنك إرسال التحويل في {{markedSentAt}} ولم يؤكد ' +
        'المورّد الاستلام منذ {{hoursPending}} ساعة. صافي الدفعة {{netSupplierPayout}} دينار ' +
        'أردني محتجز بانتظار التأكيد. المعاملة غير مموَّلة بعد والعمولة غير نهائية. تواصل مع ' +
        'المورّد أو اطلب من البنك إعادة إصدار الرمز.',
    },
  },
  ...[30, 14, 7].map((days) => ({
    key: `MATURITY_REMINDER_${days}`,
    en: {
      subject: 'Your invoice is due in {{remainingDays}} days',
      body:
        'Invoice {{invoiceNumber}} is due on {{dueDate}}. The buyer pays the bank directly; ' +
        'this is for your records.',
    },
    ar: {
      subject: 'فاتورتك تستحق خلال {{remainingDays}} يوماً',
      body:
        'الفاتورة {{invoiceNumber}} تستحق في {{dueDate}}. يدفع المشتري للبنك مباشرة؛ هذه ' +
        'الرسالة لسجلاتك.',
    },
  })),
  {
    key: 'MATURITY_REMINDER_0',
    en: {
      subject: 'Your invoice is due today',
      body:
        'Invoice {{invoiceNumber}} is due on {{dueDate}}. The buyer pays the bank directly; ' +
        'this is for your records.',
    },
    ar: {
      subject: 'فاتورتك تستحق اليوم',
      body:
        'الفاتورة {{invoiceNumber}} تستحق في {{dueDate}}. يدفع المشتري للبنك مباشرة؛ هذه ' +
        'الرسالة لسجلاتك.',
    },
  },
  {
    // ⚠️ Constrained wording (NOTIFICATIONS.md): must not assert non-payment
    // in either language. Tested in maturity.service.spec.ts and live.
    key: 'PAYMENT_OVERDUE_UNCONFIRMED',
    en: {
      subject: 'Your invoice is past its due date',
      body:
        'Invoice {{invoiceNumber}} passed its due date on {{dueDate}} and the bank has not yet ' +
        'reported whether the buyer paid. This is not a record of non-payment — it means we ' +
        'are waiting for the bank to confirm. No action is needed from you.',
    },
    ar: {
      subject: 'تجاوزت فاتورتك تاريخ استحقاقها',
      body:
        'تجاوزت الفاتورة {{invoiceNumber}} تاريخ استحقاقها في {{dueDate}} ولم يُبلغ البنك بعد ' +
        'عمّا إذا كان المشتري قد سدّد. هذا ليس تسجيلاً لعدم السداد — بل يعني أننا بانتظار ' +
        'تأكيد البنك. لا يلزمك اتخاذ أي إجراء.',
    },
  },
  {
    key: 'RECOURSE_INITIATED',
    en: {
      subject: 'Your bank has initiated recourse on a financed invoice',
      body:
        'The bank has claimed {{requestedAmount}} JOD under the recourse terms of your ' +
        'financing agreement. You will be contacted with the details. If you believe this ' +
        'claim is incorrect, you may dispute it through the platform.',
    },
    ar: {
      subject: 'بدأ بنكك إجراء الرجوع على فاتورة مموّلة',
      body:
        'طالب البنك بمبلغ {{requestedAmount}} دينار أردني بموجب شروط الرجوع في اتفاقية ' +
        'التمويل الخاصة بك. سيتم التواصل معك بالتفاصيل. إذا كنت ترى أن هذه المطالبة غير ' +
        'صحيحة، يمكنك الاعتراض عليها عبر المنصة.',
    },
  },
  {
    key: 'RECOURSE_SUPPLIER_NOTIFIED',
    en: {
      subject: 'Action needed on a recourse claim',
      body:
        'The bank is claiming {{remainingAmount}} JOD under the recourse terms of your ' +
        'financing agreement. {{notes}}',
    },
    ar: {
      subject: 'مطلوب إجراء بشأن مطالبة رجوع',
      body:
        'يطالب البنك بمبلغ {{remainingAmount}} دينار أردني بموجب شروط الرجوع في اتفاقية ' +
        'التمويل الخاصة بك. {{notes}}',
    },
  },
  {
    key: 'FRAUD_REVIEW_OPENED',
    en: {
      subject: 'A fraud review needs compliance attention',
      body:
        'A fraud review was opened on a transaction and funding is frozen pending your ' +
        'decision. Reported: {{summary}}. No finding has been recorded — only a compliance ' +
        'decision can do that (ZM-FRD-004).',
    },
    ar: {
      subject: 'مراجعة احتيال بحاجة إلى عناية الامتثال',
      body:
        'فُتحت مراجعة احتيال على معاملة وتم تجميد التمويل بانتظار قراركم. المبلَّغ عنه: ' +
        '{{summary}}. لم يُسجَّل أي استنتاج — قرار الامتثال وحده يفعل ذلك (ZM-FRD-004).',
    },
  },
];

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: /supabase\.(com|co)/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

const sessions = new Map();

async function login(persona) {
  if (sessions.has(persona)) return sessions.get(persona);
  const email = PERSONA[persona];
  const res = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_USER_PASSWORD }),
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(`Could not log in as ${email} (${res.status}). Has db:seed been run?`);
  }
  const me = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  if (!me.ok) {
    throw new Error(`The API did not answer /auth/me (${me.status}). Is it running at ${API_BASE_URL}?`);
  }
  const profile = await me.json();
  // The canonical org, never memberships[0] — the hosted database has carried
  // duplicate organizations before (see the Phase 6 daily log).
  const membership = profile.memberships.find((m) => m.organizationId === PERSONA_ORG[persona]);
  if (!membership) {
    throw new Error(`${email} has no membership in canonical org ${PERSONA_ORG[persona]}. Re-run db:seed.`);
  }
  const session = { token: body.access_token, orgId: membership.organizationId };
  sessions.set(persona, session);
  return session;
}

async function api(persona, method, path, body) {
  const session = await login(persona);
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      'X-Organization-Id': session.orgId,
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw: text };
}

const stateOf = async (id) => {
  const { rows } = await client.query(`SELECT state FROM receivable_transactions WHERE id = $1`, [id]);
  return rows[0]?.state ?? null;
};

function step(fixtureRef, message) {
  console.log(`  [${fixtureRef}] ${message}`);
}

// ---------------------------------------------------------------------------
// Stage 1 — templates
// ---------------------------------------------------------------------------

async function seedTemplates() {
  let written = 0;
  for (const t of TEMPLATES) {
    for (const [language, text] of [['EN', t.en], ['AR', t.ar]]) {
      await client.query(
        `INSERT INTO notification_templates
           (template_key, channel, language, version, subject, body_template, is_active)
         VALUES ($1,'IN_PLATFORM',$2,'1.0',$3,$4,true)
         ON CONFLICT (template_key, channel, language, version)
         DO UPDATE SET subject = EXCLUDED.subject,
                       body_template = EXCLUDED.body_template,
                       is_active = true`,
        [t.key, language, text.subject, text.body],
      );
      written += 1;
    }
  }
  console.log(`Templates: ${written} rows upserted (${TEMPLATES.length} keys × EN/AR).`);
}

// ---------------------------------------------------------------------------
// Stage 2 — inert SQL bases
// ---------------------------------------------------------------------------

let buyerId;

async function ensureBase(f, state, { withOffer = false, withDeclarations = true } = {}) {
  await client.query(
    `INSERT INTO receivable_transactions
       (id, reference_number, supplier_org_id, buyer_id, state, minimum_acceptable_amount, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [txId(f), f.ref, ORG.alNoor, buyerId, state, MONEY.floor, AL_NOOR_OWNER],
  );
  if (f.dueInDays !== null) {
    await client.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,$3,$4, CURRENT_DATE - 30, CURRENT_DATE + $5::int,
               10000.000, 1600.000, $6, 0, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [invId(f), txId(f), `DEMO-${f.ref}`, `JO-EINV-${f.ref}`, f.dueInDays, MONEY.face, `demo-p9-${f.n}`],
    );
    // Heal a stale re-run: while the fixture is still pre-acceptance —
    // nothing priced, snapshotted or contracted against it — the staged
    // invoice's due date is inert scaffolding and may be realigned. The
    // moment an offer is accepted the invoice is part of a real history and
    // is left alone.
    await client.query(
      `UPDATE invoices i
          SET due_date = CURRENT_DATE + $2::int
         FROM receivable_transactions t
        WHERE i.transaction_id = t.id AND t.id = $1
          AND t.state IN ('DRAFT','ELIGIBLE','OPEN_FOR_OFFERS')
          AND i.due_date <> CURRENT_DATE + $2::int`,
      [txId(f), f.dueInDays],
    );
  }
  if (withDeclarations) {
    await client.query(
      `INSERT INTO invoice_declarations
         (transaction_id, declaration_template_version, is_authentic, goods_delivered,
          unpaid_and_not_cancelled, no_known_dispute, not_previously_financed,
          buyer_is_named_entity, contact_is_buyer_rep, accepts_recourse, declared_by)
       VALUES ($1,'v1.0',true,true,true,true,true,true,true,true,$2)
       ON CONFLICT DO NOTHING`,
      [txId(f), AL_NOOR_OWNER],
    );
  }
  if (withOffer) {
    // The Phase 7 fixture pattern: an open listing with one ACTIVE approved
    // offer from bank A, priced with the canonical tier-1 numbers.
    await client.query(
      `INSERT INTO listings
         (id, transaction_id, round_number, status, activated_at,
          offer_submission_deadline, supplier_selection_deadline, activated_by)
       VALUES ($1,$2,1,'OPEN_FOR_OFFERS', now(), now() + interval '1 day',
               now() + interval '2 days', $3)
       ON CONFLICT (id) DO NOTHING`,
      [listingId(f), txId(f), AL_NOOR_OWNER],
    );
    await client.query(
      `INSERT INTO bank_eligibility (listing_id, bank_org_id, status, reason, rules_applied)
       VALUES ($1,$2,'ELIGIBLE','demo fixture','[]'::jsonb)
       ON CONFLICT DO NOTHING`,
      [listingId(f), ORG.bankA],
    );
    await client.query(
      `INSERT INTO listing_fee_obligations (listing_id, supplier_org_id, amount, status)
       VALUES ($1,$2,$3,'PAYABLE')
       ON CONFLICT DO NOTHING`,
      [listingId(f), ORG.alNoor, MONEY.listingFee],
    );
    await client.query(
      `INSERT INTO bank_offers
         (id, listing_id, bank_org_id, status, version_number, transaction_type, recourse_type,
          gross_funding_amount, bank_discount_amount, bank_fees_amount,
          platform_commission_amount, listing_fee_amount, other_deductions_amount,
          net_supplier_payout, valid_until, created_by, approved_by, approved_at, submitted_at)
       VALUES ($1,$2,$3,'ACTIVE',1,'INVOICE_FINANCING','FULL_RECOURSE',
               $4,$5,$6,$7,$8,0.000,$9, now() + interval '60 days',
               $10,$11, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [
        offerId(f), listingId(f), ORG.bankA,
        MONEY.gross, MONEY.discount, MONEY.fees, MONEY.commission, MONEY.listingFee, MONEY.net,
        BANK_A_MAKER, BANK_A_APPROVER,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — API-driven progressions
// ---------------------------------------------------------------------------

/** Accept → contract signed by both → mark-sent. Tolerates re-runs. */
async function driveToConfirmationPending(f) {
  let state = await stateOf(txId(f));

  if (state === 'OPEN_FOR_OFFERS') {
    const res = await api('supplier', 'POST', `/offers/${offerId(f)}/accept`);
    if (res.status !== 200) throw new Error(`[${f.ref}] accept failed (${res.status}): ${res.raw}`);
    step(f.ref, `offer accepted (net ${MONEY.net})`);
    state = await stateOf(txId(f));
  }

  if (state === 'OFFER_ACCEPTED') {
    const res = await api('supplier', 'POST', `/transactions/${txId(f)}/contract`);
    if (res.status !== 201 && res.status !== 409) {
      throw new Error(`[${f.ref}] contract generation failed (${res.status}): ${res.raw}`);
    }
    if (res.status === 201) step(f.ref, `contract generated (${res.body.id})`);
  }

  // Sign as both parties; a 409/422 means that signature already exists.
  const contract = await api('supplier', 'GET', `/transactions/${txId(f)}/contract`);
  if (contract.status === 200) {
    for (const persona of ['supplier', 'bankAApprover']) {
      // Explicit assent: `accepted: true` IS the signature (SignContractDto).
      const res = await api(persona, 'POST', `/contracts/${contract.body.id}/sign`, {
        accepted: true,
      });
      if (res.status === 200 || res.status === 201) step(f.ref, `${persona} signed`);
      else if (res.status !== 409 && res.status !== 422) {
        throw new Error(`[${f.ref}] ${persona} signing failed (${res.status}): ${res.raw}`);
      }
    }
  }

  state = await stateOf(txId(f));
  if (state === 'CONTRACTED') {
    const res = await api('bankAOps', 'POST', `/transactions/${txId(f)}/funding/mark-sent`, {
      providerReference: `WIRE-${f.ref}`,
    });
    if (res.status !== 200) throw new Error(`[${f.ref}] mark-sent failed (${res.status}): ${res.raw}`);
    step(f.ref, 'bank marked the transfer sent');
  }
}

/** OTP round trip → FUNDED. The OTP travels inside this script, never a log. */
async function driveToFunded(f) {
  await driveToConfirmationPending(f);
  if ((await stateOf(txId(f))) !== 'FUNDING_CONFIRMATION_PENDING') return;

  const otp = await api('bankAOps', 'POST', `/transactions/${txId(f)}/funding/otp`);
  if (otp.status !== 201) throw new Error(`[${f.ref}] OTP issue failed (${otp.status}): ${otp.raw}`);

  const confirm = await api('supplier', 'POST', `/transactions/${txId(f)}/funding/confirm`, {
    otp: otp.body.otp,
  });
  if (confirm.status !== 200) {
    throw new Error(`[${f.ref}] funding confirm failed (${confirm.status}): ${confirm.raw}`);
  }
  step(f.ref, `FUNDED (settlement ${confirm.body.settlementId ?? 'recorded'})`);
}

/**
 * Every staged fixture gets a real ELECTRONIC_INVOICE document, uploaded
 * through the real signed-URL flow as the supplier. Without one, the risk
 * engine's `BLOCK_NO_ELECTRONIC_INVOICE` hard blocker caps the composite at
 * the blocked ceiling and every demo receivable reads CRITICAL — technically
 * correct for the facts on the ground, and exactly the wrong first
 * impression. Inserting a bare `documents` row instead would trade that
 * blocker for the file-integrity one (no bytes in storage to hash), so the
 * bytes go up for real.
 */
async function ensureEinvoiceDocument(f) {
  const findDoc = async () => {
    const { rows } = await client.query(
      `SELECT id, file_hash FROM documents
        WHERE subject_type = 'TRANSACTION' AND subject_id = $1
          AND document_type = 'ELECTRONIC_INVOICE'
        ORDER BY uploaded_at DESC LIMIT 1`,
      [txId(f)],
    );
    return rows[0] ?? null;
  };

  let doc = await findDoc();
  let changed = false;

  if (!doc) {
    const pdf = readFileSync(
      join(repoRoot, 'db', 'seed', 'einvoices', 'INV-2026-0001-alnoor-amman-retail.pdf'),
    );
    const issued = await api('supplier', 'POST', '/documents/upload-url', {
      documentType: 'ELECTRONIC_INVOICE',
      fileName: `${f.ref}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: pdf.length,
      subjectType: 'TRANSACTION',
      subjectId: txId(f),
    });
    if (issued.status !== 200) {
      throw new Error(`[${f.ref}] upload-url failed (${issued.status}): ${issued.raw}`);
    }
    const put = await fetch(issued.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: new Uint8Array(pdf),
    });
    if (!put.ok) throw new Error(`[${f.ref}] storage PUT failed (${put.status})`);
    step(f.ref, 'e-invoice document uploaded');
    doc = await findDoc();
    changed = true;
  }

  // The bytes are hashed and OCR'd at finalization, which the wizard
  // triggers by reading the extraction. Until then file_hash is empty and
  // the integrity check would (correctly) refuse to vouch for the file.
  if (doc && !doc.file_hash) {
    const ex = await api('supplier', 'GET', `/documents/${doc.id}/extraction`);
    if (ex.status !== 200) {
      throw new Error(`[${f.ref}] finalize/extraction failed (${ex.status}): ${ex.raw}`);
    }
    step(f.ref, 'e-invoice finalized (hash + OCR)');
    changed = true;
  }

  // A stored assessment computed before the document was in place is a
  // stale derived cache, not evidence — no decision consumed it (GET /risk
  // computes on first read; the fixtures' acceptances predate any
  // assessment). Dropping it makes the next read recompute the real facts —
  // and the read happens here, so the stored score is the staging-time one.
  // In the real flow the displayed score is the submission-era assessment,
  // not a live recompute; pre-warming gives the fixtures the same property.
  if (changed) {
    await client.query(`DELETE FROM risk_assessments WHERE transaction_id = $1`, [txId(f)]);
    const risk = await api('supplier', 'GET', `/transactions/${txId(f)}/risk`);
    if (risk.status === 200) {
      step(f.ref, `trust score ${risk.body.compositeScore} (${risk.body.band})`);
    }
  }
}

/**
 * The demo time machine, driven through its real API (9.2): the platform
 * setting armed by a platform admin, the jump audited, the offset applied in
 * exactly one place. This script never touches `demo_time_offsets` directly.
 */
async function armTimeMachine(on) {
  const res = await api('platformAdmin', 'PATCH', `/admin/settings`, {
    demo_time_machine_enabled: on,
  });
  if (res.status !== 200) {
    throw new Error(`arming the time machine (${on}) failed (${res.status}): ${res.raw}`);
  }
  console.log(`  [time-machine] ${on ? 'armed' : 'disarmed'}`);
}

async function timeTravel(offsetDays) {
  const res = await api('platformAdmin', 'POST', `/demo/time-travel`, { offsetDays });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`time-travel(${offsetDays}) failed (${res.status}): ${res.raw}`);
  }
  console.log(`  [time-machine] offset now ${offsetDays} day(s), effective ${res.body.effectiveDate ?? '?'}`);
}

/**
 * OVERDUE_UNCONFIRMED is the sweep's to write, never this script's. Funded
 * and then aged past maturity by the time machine, the next scheduler tick
 * must pick it up.
 */
async function awaitSweep(f, timeoutMs = 180_000) {
  const startedAt = Date.now();
  process.stdout.write(`  [${f.ref}] waiting for the maturity sweep`);
  for (;;) {
    const state = await stateOf(txId(f));
    if (state === 'OVERDUE_UNCONFIRMED') {
      console.log(' → OVERDUE_UNCONFIRMED');
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      console.log('');
      throw new Error(
        `[${f.ref}] still ${state} after ${timeoutMs / 1000}s. The maturity sweep did not run — ` +
          'is the API running with its scheduler enabled?',
      );
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

// ---------------------------------------------------------------------------
// Status / purge
// ---------------------------------------------------------------------------

async function report() {
  const { rows: templates } = await client.query(
    `SELECT count(*)::int AS n FROM notification_templates WHERE version = '1.0' AND channel = 'IN_PLATFORM'`,
  );
  console.log(`Templates present: ${templates[0].n}`);
  for (const f of FIXTURES) {
    const state = await stateOf(txId(f));
    console.log(`  ${f.ref.padEnd(22)} ${state ?? 'absent'}  (target ${f.slot})`);
  }
}

async function purgeRemovable() {
  console.log('--purge: removing what can be removed …');
  for (const f of FIXTURES) {
    const { rows: hasLedger } = await client.query(
      `SELECT 1 FROM ledger_entries WHERE transaction_id = $1 LIMIT 1`,
      [txId(f)],
    );
    if (hasLedger.length > 0) {
      // Append-only by database rule (INV-7). A financial journal a script
      // can erase is not a journal; the chain stays.
      console.log(`  ${f.ref}: has ledger entries — left intact.`);
      continue;
    }
    await client.query('BEGIN');
    try {
      // accepted_offer_snapshots references offer_selections, so the
      // snapshot rows must go before the selections they point at.
      await client.query(
        `DELETE FROM contract_signatures WHERE contract_id IN
           (SELECT id FROM contracts WHERE transaction_id = $1)`,
        [txId(f)],
      );
      for (const table of ['contracts', 'accepted_offer_snapshots']) {
        await client.query(`DELETE FROM ${table} WHERE transaction_id = $1`, [txId(f)]);
      }
      for (const child of ['offer_conditions', 'offer_selections']) {
        await client.query(
          `DELETE FROM ${child} WHERE offer_id IN
             (SELECT o.id FROM bank_offers o JOIN listings l ON l.id = o.listing_id
               WHERE l.transaction_id = $1)`,
          [txId(f)],
        );
      }
      for (const [table, column] of [
        ['bank_offers', 'listing_id'],
        ['bank_eligibility', 'listing_id'],
        ['listing_fee_obligations', 'listing_id'],
      ]) {
        await client.query(
          `DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM listings WHERE transaction_id = $1)`,
          [txId(f)],
        );
      }
      for (const table of [
        'commission_calculations',
        'settlements',
        'notifications',
        'listings',
        'risk_assessments',
        'invoice_declarations',
        'invoices',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE transaction_id = $1`, [txId(f)]);
      }
      await client.query(
        `DELETE FROM status_history WHERE entity_type = 'TRANSACTION' AND entity_id = $1`,
        [txId(f)],
      );
      await client.query(`DELETE FROM audit_logs WHERE target_entity_id = $1`, [txId(f)]);
      await client.query(`DELETE FROM receivable_transactions WHERE id = $1`, [txId(f)]);
      await client.query('COMMIT');
      console.log(`  ${f.ref}: removed.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.log(`  ${f.ref}: not removed (${err.message}).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  await client.connect();

  if (statusOnly) {
    await report();
    process.exit(0);
  }
  if (purge) {
    await purgeRemovable();
    process.exit(0);
  }

  const { rows: buyers } = await client.query(
    `SELECT id FROM buyers WHERE national_establishment_no = $1`,
    [BUYER_ESTABLISHMENT],
  );
  if (buyers.length === 0) throw new Error('Buyer fixture missing. Run db:seed first.');
  buyerId = buyers[0].id;

  await seedTemplates();

  const F = Object.fromEntries(FIXTURES.map((f) => [f.n, f]));

  // 1 — DRAFT. The presenter fills the invoice live; no invoice is staged.
  await ensureBase(F[1], 'DRAFT', { withDeclarations: false });
  step(F[1].ref, `${await stateOf(txId(F[1]))}`);

  // 2 — ELIGIBLE, ready to be listed on stage.
  await ensureBase(F[2], 'ELIGIBLE');
  step(F[2].ref, `${await stateOf(txId(F[2]))}`);

  // 6 & 7 — the matured pair, staged FIRST among the walked fixtures.
  // Funded while the receivable is still a day from maturity, then aged past
  // it with the demo time machine — the same lever the live demo pulls — so
  // the real sweep marks them and the bank's confirmation and recourse claim
  // are real API calls. The clock returns to zero and the machine is
  // disarmed before any date-sensitive fixture below is staged; their
  // timestamps sit a couple of days ahead of the wall clock afterwards,
  // which is the time machine's honest artifact, not an error.
  {
    const done6 = (await stateOf(txId(F[6]))) === 'OVERDUE_UNCONFIRMED';
    const done7 = (await stateOf(txId(F[7]))) === 'RECOURSE_ACTIVE';
    if (!done6 || !done7) {
      await ensureBase(F[6], 'OPEN_FOR_OFFERS', { withOffer: true });
      await ensureBase(F[7], 'OPEN_FOR_OFFERS', { withOffer: true });
      if (!done6) await driveToFunded(F[6]);
      if (!done7) await driveToFunded(F[7]);

      await armTimeMachine(true);
      await timeTravel(2);
      try {
        if ((await stateOf(txId(F[6]))) === 'FUNDED') await awaitSweep(F[6]);
        if ((await stateOf(txId(F[7]))) === 'FUNDED') await awaitSweep(F[7]);

        if ((await stateOf(txId(F[7]))) === 'OVERDUE_UNCONFIRMED') {
          const res = await api('bankAOps', 'POST', `/transactions/${txId(F[7])}/confirm-status`, {
            status: 'OVERDUE',
            notes: 'Buyer contacted; no payment received by maturity.',
          });
          if (res.status !== 200 && res.status !== 201) {
            throw new Error(`[${F[7].ref}] confirm OVERDUE failed (${res.status}): ${res.raw}`);
          }
          step(F[7].ref, 'bank confirmed OVERDUE');
        }
        if ((await stateOf(txId(F[7]))) === 'OVERDUE') {
          const res = await api('bankAOps', 'POST', `/transactions/${txId(F[7])}/recourse`, {
            reason: 'NON_PAYMENT',
            requestedAmount: MONEY.gross, // never more than the bank advanced (ZM-REC-004)
          });
          if (res.status !== 201) {
            throw new Error(`[${F[7].ref}] recourse failed (${res.status}): ${res.raw}`);
          }
          step(F[7].ref, `recourse case opened (${res.body.id})`);
        }
      } finally {
        // Whatever happened above, the clock never stays moved.
        await timeTravel(0);
        await armTimeMachine(false);
      }
    }
    step(F[6].ref, `${await stateOf(txId(F[6]))}`);
    step(F[7].ref, `${await stateOf(txId(F[7]))}`);
  }

  // 3 — OPEN_FOR_OFFERS with two approved offers side by side, created and
  // approved through the API so each is priced, evaluated and audited. Bank B
  // advances more gross and nets less — the comparison screen's whole point.
  {
    const f = F[3];
    await ensureBase(f, 'ELIGIBLE');
    let openListingId = null;
    const { rows } = await client.query(
      `SELECT id FROM listings WHERE transaction_id = $1
        AND status IN ('OPEN_FOR_OFFERS','OFFER_PERIOD_CLOSED','AWAITING_SELECTION')
        ORDER BY activated_at DESC LIMIT 1`,
      [txId(f)],
    );
    openListingId = rows[0]?.id ?? null;
    if (!openListingId) {
      const res = await api('supplier', 'POST', `/transactions/${txId(f)}/listing`);
      if (res.status !== 201) throw new Error(`[${f.ref}] listing failed (${res.status}): ${res.raw}`);
      openListingId = res.body.id;
      step(f.ref, `listing activated (${openListingId})`);
    }
    for (const offer of [
      {
        maker: 'bankAMaker', approver: 'bankAApprover', bank: 'Jordan National Bank',
        body: {
          transactionType: 'INVOICE_FINANCING', recourseType: 'FULL_RECOURSE',
          grossFundingAmount: '9000.000', bankDiscountAmount: '300.000',
          bankFeesAmount: '150.000', otherDeductionsAmount: '0.000',
        },
      },
      {
        maker: 'bankBMaker', approver: 'bankBApprover', bank: 'Levant Commercial Bank',
        body: {
          transactionType: 'RECEIVABLE_PURCHASE', recourseType: 'NON_RECOURSE',
          grossFundingAmount: '9200.000', bankDiscountAmount: '520.000',
          bankFeesAmount: '180.000', otherDeductionsAmount: '0.000',
        },
      },
    ]) {
      const { rows: existing } = await client.query(
        `SELECT o.id, o.status FROM bank_offers o
          WHERE o.listing_id = $1 AND o.bank_org_id = $2
          ORDER BY o.submitted_at DESC NULLS LAST LIMIT 1`,
        [openListingId, PERSONA_ORG[offer.maker]],
      );
      let id = existing[0]?.id;
      if (!id) {
        const res = await api(offer.maker, 'POST', `/listings/${openListingId}/offers/create`, {
          ...offer.body,
          validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        });
        if (res.status !== 201) throw new Error(`[${f.ref}] ${offer.bank} offer failed (${res.status}): ${res.raw}`);
        id = res.body.id;
        step(f.ref, `${offer.bank}: offer created, net ${res.body.netSupplierPayout}`);
      }
      if (!existing[0] || existing[0].status === 'PENDING_INTERNAL_APPROVAL') {
        const res = await api(offer.approver, 'POST', `/offers/${id}/approve`);
        if (res.status === 200 || res.status === 201) step(f.ref, `${offer.bank}: offer approved`);
        else if (res.status !== 409) {
          throw new Error(`[${f.ref}] ${offer.bank} approval failed (${res.status}): ${res.raw}`);
        }
      }
    }
  }

  // 4 — stopped at FUNDING_CONFIRMATION_PENDING: the wire is sent, the
  // supplier's confirmation screen is live, the OTP is with the bank.
  await ensureBase(F[4], 'OPEN_FOR_OFFERS', { withOffer: true });
  await driveToConfirmationPending(F[4]);
  step(F[4].ref, `${await stateOf(txId(F[4]))}`);

  // 10 — FUNDED, due in 8 days: the time machine's target.
  await ensureBase(F[10], 'OPEN_FOR_OFFERS', { withOffer: true });
  await driveToFunded(F[10]);
  step(F[10].ref, `${await stateOf(txId(F[10]))}`);

  // 8 — PAID: the buyer's payment recorded in full by the bank, then the
  // bank's confirmation. Balances are derived (D-13); nothing is hand-set.
  {
    const f = F[8];
    await ensureBase(f, 'OPEN_FOR_OFFERS', { withOffer: true });
    await driveToFunded(f);
    let state = await stateOf(txId(f));
    if (state === 'FUNDED' || state === 'OVERDUE_UNCONFIRMED') {
      const paid = await api('bankAOps', 'POST', `/transactions/${txId(f)}/payments`, {
        amount: MONEY.face,
        paymentDate: new Date().toISOString().slice(0, 10),
        bankReference: `BUYER-WIRE-${f.ref}`,
      });
      if (paid.status !== 201 && paid.status !== 409) {
        throw new Error(`[${f.ref}] payment failed (${paid.status}): ${paid.raw}`);
      }
      step(f.ref, 'buyer payment recorded in full');
      // A payment that settles the outstanding moves the state to PAID by
      // itself (derived balances, D-13). The explicit confirmation only
      // applies when something is still awaiting it.
      state = await stateOf(txId(f));
      if (state === 'FUNDED' || state === 'PARTIALLY_PAID' || state === 'OVERDUE_UNCONFIRMED') {
        const confirm = await api('bankAOps', 'POST', `/transactions/${txId(f)}/confirm-status`, {
          status: 'PAID',
        });
        if (confirm.status !== 200 && confirm.status !== 201) {
          throw new Error(`[${f.ref}] confirm PAID failed (${confirm.status}): ${confirm.raw}`);
        }
        step(f.ref, 'bank confirmed PAID');
      }
    }
    step(f.ref, `${await stateOf(txId(f))}`);
  }

  // 9 — CANCELLED through the Phase 9 endpoint: a recorded terminal state
  // with its listing and offers closed, never a delete (INV-7).
  {
    const f = F[9];
    await ensureBase(f, 'ELIGIBLE');
    if ((await stateOf(txId(f))) === 'ELIGIBLE') {
      const res = await api('supplier', 'POST', `/transactions/${txId(f)}/listing`);
      if (res.status !== 201) throw new Error(`[${f.ref}] listing failed (${res.status}): ${res.raw}`);
      step(f.ref, 'listed');
    }
    if ((await stateOf(txId(f))) === 'OPEN_FOR_OFFERS') {
      const res = await api('supplier', 'POST', `/transactions/${txId(f)}/cancel`, {
        reason: 'Demo: supplier withdrew the receivable before any offer.',
      });
      if (res.status !== 200) throw new Error(`[${f.ref}] cancel failed (${res.status}): ${res.raw}`);
      step(f.ref, 'cancelled');
    }
    step(f.ref, `${await stateOf(txId(f))}`);
  }

  // Every fixture with an invoice gets its e-invoice bytes, so no demo
  // receivable carries the BLOCK_NO_ELECTRONIC_INVOICE cap.
  for (const f of FIXTURES) {
    if (f.dueInDays !== null) await ensureEinvoiceDocument(f);
  }

  console.log('\nDemo population staged. Current states:');
  await report();
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
