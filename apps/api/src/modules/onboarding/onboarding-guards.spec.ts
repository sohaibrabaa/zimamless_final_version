import { OnboardingService, ActorContext, ApplicationRow } from './onboarding.service';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * The Phase 2 unification fixes, each proven at the service seam with a
 * scripted database. These are the behaviours that existed only as silent
 * gaps before the audit: free-string catalogues, writes to decided
 * applications, discarded attachments, and the unreachable outage-recovery
 * path.
 */

const SUPPLIER: ActorContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  organizationType: 'SUPPLIER',
  roles: ['SUPPLIER_OWNER'],
};

const REVIEWER: ActorContext = {
  userId: 'user-9',
  organizationId: 'org-platform',
  organizationType: 'PLATFORM',
  roles: ['PLATFORM_SUPPLIER_REVIEWER'],
};

function appRow(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: 'app-1',
    organization_id: 'org-1',
    status: 'UNDER_REVIEW',
    submitted_at: new Date('2026-07-20T09:00:00Z'),
    decided_at: null,
    decision_reason_code: null,
    decision_notes: null,
    ...overrides,
  };
}

/** Minimal scripted db: queryOne answers from a queue, query from a map of SQL fragments. */
function makeService(overrides: {
  queryOne?: jest.Mock;
  query?: jest.Mock;
  transaction?: jest.Mock;
} = {}) {
  const db = {
    queryOne: overrides.queryOne ?? jest.fn().mockResolvedValue(appRow()),
    query: overrides.query ?? jest.fn().mockResolvedValue({ rows: [] }),
    transaction:
      overrides.transaction ??
      jest.fn(async (fn: (client: unknown) => Promise<unknown>) =>
        fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
      ),
  };
  const government = {
    effectiveFields: jest.fn().mockResolvedValue({}),
    listRequestsForSubject: jest.fn().mockResolvedValue([]),
    recordSelfDeclared: jest.fn(),
    lookupAll: jest.fn(),
  };
  const sla = {
    stateOf: jest.fn().mockResolvedValue({
      deadlineAt: null,
      remainingBusinessSeconds: 0,
      paused: false,
      pausedReason: null,
    }),
    record: jest.fn(),
    syncApplicationColumns: jest.fn(),
  };
  const config = { encryptionKey: 'test-key' };
  const time = { now: () => new Date('2026-07-23T10:00:00Z'), nowMs: () => 0 };

  const service = new OnboardingService(
    db as never,
    config as never,
    government as never,
    sla as never,
    time as never,
  );
  return { service, db, government, sla };
}

describe('decide reason-code validation (Q-06)', () => {
  it('refuses a reason code outside the shared catalogue', async () => {
    const { service } = makeService();
    await expect(
      service.decide('app-1', REVIEWER, { decision: 'REJECTED', reasonCode: 'MADE_UP_CODE' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('refuses an automated code from a reviewer — asserting a registry fact by hand', async () => {
    const { service } = makeService();
    await expect(
      service.decide('app-1', REVIEWER, {
        decision: 'REJECTED',
        reasonCode: 'SOLE_PROPRIETORSHIP_NOT_ELIGIBLE',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('accepts a catalogue code', async () => {
    const { service } = makeService();
    await expect(
      service.decide('app-1', REVIEWER, { decision: 'REJECTED', reasonCode: 'COMPANY_NOT_ACTIVE' }),
    ).resolves.toBeDefined();
  });
});

describe('supplier edit gating (writes to decided applications)', () => {
  it.each(['APPROVED', 'REJECTED', 'UNDER_REVIEW'] as const)(
    'refuses a bank-account write in %s',
    async (status) => {
      const { service } = makeService({
        queryOne: jest.fn().mockResolvedValue(appRow({ status })),
      });
      await expect(
        service.addBankAccount('app-1', SUPPLIER, {
          iban: 'JO94CBJO0010000000000131000302',
          bankName: 'CBJ',
          accountHolderName: 'Al-Noor Trading Company',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION });
    },
  );

  it('permits consent writes in DRAFT', async () => {
    const { service } = makeService({
      queryOne: jest.fn().mockResolvedValue(appRow({ status: 'DRAFT' })),
    });
    await expect(
      service.recordConsents('app-1', SUPPLIER, [
        { consentType: 'TERMS_OF_SERVICE', consentVersion: '1.0', granted: true },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe('consent vocabulary (Q-09)', () => {
  it('refuses a consent type outside the whitelist', async () => {
    const { service } = makeService({
      queryOne: jest.fn().mockResolvedValue(appRow({ status: 'DRAFT' })),
    });
    await expect(
      service.recordConsents('app-1', SUPPLIER, [
        { consentType: 'PLATFORM_TERMS', consentVersion: '1.0', granted: true },
      ]),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('refuses submission until all four essential consents are granted', async () => {
    const { service } = makeService({
      queryOne: jest.fn().mockResolvedValue(appRow({ status: 'DRAFT' })),
      query: jest.fn().mockResolvedValue({
        rows: [
          { consent_type: 'TERMS_OF_SERVICE', granted: true },
          { consent_type: 'PRIVACY_POLICY', granted: true },
          // The two authorizations are missing.
        ],
      }),
    });
    await expect(service.submit('app-1', SUPPLIER)).rejects.toMatchObject({
      code: ErrorCode.CONSENTS_REQUIRED,
    });
  });
});

describe('respond attachments (silent-discard fix)', () => {
  it('refuses documentIds loudly until the documents feature exists', async () => {
    const { service } = makeService();
    await expect(
      service.respond('app-1', SUPPLIER, {
        informationRequestId: 'req-1',
        response: 'Here you go',
        documentIds: ['doc-1'],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });
});

describe('register idempotency respects the body', () => {
  function transactionWithExisting(establishmentNo: string) {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            organization_id: 'org-1',
            application_id: 'app-1',
            national_establishment_no: establishmentNo,
          },
        ],
      }),
    };
    return jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  }

  it('returns the existing ids for the SAME establishment number', async () => {
    const { service } = makeService({ transaction: transactionWithExisting('20000101') });
    await expect(
      service.register('user-1', {
        nationalEstablishmentNumber: '20000101',
        professionLicenceNumber: 'GAM-1',
      }),
    ).resolves.toMatchObject({ organizationId: 'org-1', created: false });
  });

  it('409s for a DIFFERENT establishment number instead of silently echoing the first org', async () => {
    const { service } = makeService({ transaction: transactionWithExisting('20000101') });
    await expect(
      service.register('user-1', {
        nationalEstablishmentNumber: '20000199',
        professionLicenceNumber: 'GAM-1',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });
});

describe('outage recovery through public routes (the unreachable-path fix)', () => {
  it('retries a paused application the caller owns', async () => {
    const paused = appRow({ status: 'GOVERNMENT_SERVICE_UNAVAILABLE' });
    const { service } = makeService({ queryOne: jest.fn().mockResolvedValue(paused) });
    const retry = jest.spyOn(service, 'retryGovernment').mockResolvedValue({});

    await service.resumeIfWaiting('20000103', SUPPLIER);
    expect(retry).toHaveBeenCalledWith('app-1', SUPPLIER);
  });

  it("is a silent no-op for another organization's establishment number", async () => {
    const paused = appRow({ status: 'GOVERNMENT_SERVICE_UNAVAILABLE', organization_id: 'org-2' });
    const { service } = makeService({ queryOne: jest.fn().mockResolvedValue(paused) });
    const retry = jest.spyOn(service, 'retryGovernment').mockResolvedValue({});

    await service.resumeIfWaiting('20000103', SUPPLIER);
    expect(retry).not.toHaveBeenCalled();
  });

  it('is a silent no-op when nothing is waiting', async () => {
    const { service } = makeService({ queryOne: jest.fn().mockResolvedValue(null) });
    const retry = jest.spyOn(service, 'retryGovernment').mockResolvedValue({});

    await service.resumeIfWaiting('20000101', SUPPLIER);
    expect(retry).not.toHaveBeenCalled();
  });

  it('lets platform staff resume any paused application', async () => {
    const paused = appRow({ status: 'GOVERNMENT_SERVICE_UNAVAILABLE', organization_id: 'org-2' });
    const { service } = makeService({ queryOne: jest.fn().mockResolvedValue(paused) });
    const retry = jest.spyOn(service, 'retryGovernment').mockResolvedValue({});

    await service.resumeIfWaiting('20000103', REVIEWER);
    expect(retry).toHaveBeenCalledWith('app-1', REVIEWER);
  });

  it('still refuses retryGovernment outside the outage state', async () => {
    const { service } = makeService({
      queryOne: jest.fn().mockResolvedValue(appRow({ status: 'UNDER_REVIEW' })),
    });
    await expect(service.retryGovernment('app-1', SUPPLIER)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    });
  });
});
