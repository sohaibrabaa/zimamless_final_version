import { TransactionsService, TransactionRow } from './transactions.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { DECLARATION_TEMPLATE_VERSIONS } from './declaration-catalogue';

/**
 * The Phase 3 unification fixes at the transactions seam, proven against a
 * scripted database.
 *
 * Both behaviours here existed only as silent gaps before the audit: a
 * free-string declaration template version (the Q-09 failure mode, repeating
 * exactly as Agent B predicted it would), and a transaction that could not
 * enumerate its own documents.
 */

const SUPPLIER: ActorContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  organizationType: 'SUPPLIER',
  roles: ['SUPPLIER_OWNER'],
};

function txRow(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 'tx-1',
    reference_number: 'ZM-1001',
    supplier_org_id: 'org-1',
    buyer_id: 'buyer-1',
    state: 'DRAFT',
    minimum_acceptable_amount: null,
    currency: 'JOD',
    locked_at: null,
    created_by: 'user-1',
    created_at: new Date('2026-07-20T09:00:00Z'),
    updated_at: new Date('2026-07-20T09:00:00Z'),
    closure_reason: null,
    ...overrides,
  } as TransactionRow;
}

function makeService(overrides: { listForSubject?: jest.Mock } = {}) {
  const db = {
    queryOne: jest.fn().mockResolvedValue(txRow()),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
    ),
  };
  const documents = {
    listForSubject: overrides.listForSubject ?? jest.fn().mockResolvedValue([]),
    latestExtractions: jest.fn().mockResolvedValue([]),
  };
  const buyers = { findById: jest.fn().mockResolvedValue(null), describe: jest.fn() };
  const government = { effectiveFields: jest.fn().mockResolvedValue({}) };
  const audit = { record: jest.fn() };
  const time = { now: () => new Date('2026-07-23T10:00:00Z'), nowMs: () => 0 };

  const service = new TransactionsService(
    db as never,
    government as never,
    buyers as never,
    documents as never,
    audit as never,
    time as never,
  );
  return { service, db, documents };
}

const AFFIRMED = {
  isAuthentic: true,
  goodsDelivered: true,
  unpaidAndNotCancelled: true,
  noKnownDispute: true,
  notPreviouslyFinanced: true,
  buyerIsNamedEntity: true,
  contactIsBuyerRep: true,
  acceptsRecourse: true,
};

describe('declaration template version (Q-13)', () => {
  it('accepts the published version', async () => {
    const { service } = makeService();
    await expect(
      service.recordDeclarations('tx-1', SUPPLIER, {
        ...AFFIRMED,
        declarationTemplateVersion: '1.0',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a version outside the catalogue instead of storing it', async () => {
    // Before this catalogue existed the service took any non-empty string,
    // so the two halves could have shipped different versions and only
    // found out on the first integration day — the Q-09 defect verbatim.
    const { service } = makeService();
    await expect(
      service.recordDeclarations('tx-1', SUPPLIER, {
        ...AFFIRMED,
        declarationTemplateVersion: '2.0',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('names the accepted versions in the refusal, so a client can correct itself', async () => {
    const { service } = makeService();
    await expect(
      service.recordDeclarations('tx-1', SUPPLIER, {
        ...AFFIRMED,
        declarationTemplateVersion: 'v1',
      }),
    ).rejects.toMatchObject({ details: { accepted: [...DECLARATION_TEMPLATE_VERSIONS] } });
  });

  it('still refuses an absent version (LT-04)', async () => {
    const { service } = makeService();
    await expect(
      service.recordDeclarations('tx-1', SUPPLIER, { ...AFFIRMED }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('refuses an unaffirmed declaration before it looks at the version', async () => {
    // Ordering matters: a supplier who declined a declaration should be told
    // that, not sent to fix a version string they never chose.
    const { service } = makeService();
    await expect(
      service.recordDeclarations('tx-1', SUPPLIER, {
        ...AFFIRMED,
        acceptsRecourse: false,
        declarationTemplateVersion: 'nonsense',
      }),
    ).rejects.toMatchObject({ details: { notAffirmed: ['acceptsRecourse'] } });
  });
});

describe('the transaction lists its own documents (Q-12)', () => {
  const doc = {
    id: 'doc-1',
    document_type: 'ELECTRONIC_INVOICE',
    file_name: 'INV-2026-0001.pdf',
    uploaded_at: new Date('2026-07-21T08:30:00Z'),
  };

  it('carries documents[] on the detail view, shaped like the listing schema', async () => {
    const { service } = makeService({ listForSubject: jest.fn().mockResolvedValue([doc]) });
    const detail = await service.describe(txRow(), 'SUPPLIER', { includeDetail: true });
    expect(detail.documents).toEqual([
      {
        id: 'doc-1',
        documentType: 'ELECTRONIC_INVOICE',
        fileName: 'INV-2026-0001.pdf',
        uploadedAt: '2026-07-21T08:30:00.000Z',
      },
    ]);
  });

  it('omits documents[] from the summary — a list view does not enumerate attachments', async () => {
    const { service, documents } = makeService({
      listForSubject: jest.fn().mockResolvedValue([doc]),
    });
    const summary = await service.describe(txRow(), 'SUPPLIER');
    expect(summary).not.toHaveProperty('documents');
    // And it does not pay for the query it does not use.
    expect(documents.listForSubject).not.toHaveBeenCalled();
  });

  it('is an empty array, never absent, when nothing is attached', async () => {
    // "No documents" and "the API does not tell us about documents" are
    // different facts, and the client renders them differently.
    const { service } = makeService();
    const detail = await service.describe(txRow(), 'SUPPLIER', { includeDetail: true });
    expect(detail.documents).toEqual([]);
  });

  it('gives a bank the document list but never the supplier floor (INV-8)', async () => {
    const { service } = makeService({ listForSubject: jest.fn().mockResolvedValue([doc]) });
    const detail = await service.describe(
      txRow({ minimum_acceptable_amount: '11000.000' } as Partial<TransactionRow>),
      'BANK',
      { includeDetail: true },
    );
    expect(detail.documents).toHaveLength(1);
    expect(detail).not.toHaveProperty('minimumAcceptableAmount');
  });
});
