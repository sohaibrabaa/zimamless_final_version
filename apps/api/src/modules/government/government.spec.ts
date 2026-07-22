import { CcdAdapter, GamAdapter, IstdAdapter } from './dummy-adapters';
import {
  GovernmentAdapter,
  GovernmentLookupResult,
  dataAvailabilityOf,
  isAdverseFinding,
  isSourceAvailable,
} from './government-adapter';
import {
  DEFAULT_RESILIENCE,
  ResilientGovernmentAdapter,
  ResilienceOptions,
} from './resilient-adapter';

/**
 * Government adapters — and INV-9, the invariant this phase exists to prove.
 *
 * INV-9: a source that did not answer must reduce `dataAvailabilityPct` and
 * NOTHING ELSE. `90000001` (unavailable) and `90000002` (not found) are the
 * paired fixture from GOV_DUMMY_DATA §5: identical in every respect except
 * whether the registry answered. Any code path that treats them the same is
 * the defect hard rule 7 names.
 *
 * Named CI test for INV-9, shipped in the phase that implements it (hard
 * rule 10), not deferred to Phase 9.
 */

const ccd = new CcdAdapter();
const istd = new IstdAdapter();
const gam = new GamAdapter();

describe('dummy government adapters', () => {
  describe('INV-9 — unavailable is not adverse', () => {
    let unavailable: GovernmentLookupResult;
    let notFound: GovernmentLookupResult;

    beforeAll(async () => {
      unavailable = await ccd.lookup('90000001');
      notFound = await ccd.lookup('90000002');
    });

    it('reports the source as unavailable only when it did not answer', () => {
      expect(isSourceAvailable(unavailable)).toBe(false);
      // The registry answered "no such entity". It was available.
      expect(isSourceAvailable(notFound)).toBe(true);
    });

    it('records the two as different statuses', () => {
      expect(unavailable.status).toBe('UNAVAILABLE');
      expect(notFound.status).toBe('NOT_FOUND');
    });

    it('counts only the unanswered one against data availability', () => {
      expect(dataAvailabilityOf(unavailable)).toBe(0);
      // NOT_FOUND is complete information: the registry looked, and there is
      // nothing there. Full availability, adverse content.
      expect(dataAvailabilityOf(notFound)).toBe(1);
    });

    it('treats only the answered one as a finding about the subject', () => {
      expect(isAdverseFinding(unavailable)).toBe(false);
      expect(isAdverseFinding(notFound)).toBe(true);
    });

    it('carries no subject data on an unanswered result — the shape forbids it', () => {
      // The union has no `normalized` on the unanswered branch at all, so
      // there is no field for an outage to be mistaken for a finding in.
      expect('normalized' in unavailable).toBe(false);
      expect('raw' in unavailable).toBe(false);
      expect(unavailable.kind).toBe('UNANSWERED');
    });
  });

  describe('determinism', () => {
    it('returns the same answer for the same key every time', async () => {
      const a = await ccd.lookup('20000101');
      const b = await ccd.lookup('20000101');
      expect(b).toEqual(a);
    });

    it('drops the same fields on every PARTIAL', async () => {
      const a = await ccd.lookup('90000003');
      const b = await ccd.lookup('90000003');
      expect(a.status).toBe('PARTIAL');
      expect(b).toEqual(a);
    });
  });

  describe('per-identity behaviour from GOV_DUMMY_DATA §2', () => {
    it('S1 (20000101) answers in full from every source', async () => {
      for (const adapter of [ccd, istd, gam]) {
        const result = await adapter.lookup('20000101');
        expect(result.status).toBe('SUCCESS');
        expect(dataAvailabilityOf(result)).toBe(1);
      }
    });

    it('S2 (20000102) is CCD full, GAM partial', async () => {
      expect((await ccd.lookup('20000102')).status).toBe('SUCCESS');
      const gamResult = await gam.lookup('20000102');
      expect(gamResult.status).toBe('PARTIAL');
      expect(dataAvailabilityOf(gamResult)).toBeGreaterThan(0);
      expect(dataAvailabilityOf(gamResult)).toBeLessThan(1);
    });

    it('S3 (20000103) has ISTD unavailable — the SLA-pause scenario', async () => {
      const istdResult = await istd.lookup('20000103');
      expect(isSourceAvailable(istdResult)).toBe(false);
      expect(istdResult.status).toBe('UNAVAILABLE');
      // The other two sources are unaffected: unavailability is per source.
      expect(isSourceAvailable(await ccd.lookup('20000103'))).toBe(true);
      expect(isSourceAvailable(await gam.lookup('20000103'))).toBe(true);
    });

    it('S4 (20000104) is a sole proprietorship — ZM-SON-012/013', async () => {
      const result = await ccd.lookup('20000104');
      expect(result.kind).toBe('ANSWERED');
      if (result.kind !== 'ANSWERED') throw new Error('unreachable');
      expect(result.normalized.companyType).toBe('SOLE_PROPRIETORSHIP');
    });

    it('reports an unknown number as NOT_FOUND, not UNAVAILABLE', async () => {
      // The registry was reachable and said there is no such entity.
      const result = await ccd.lookup('20009999');
      expect(result.status).toBe('NOT_FOUND');
      expect(isSourceAvailable(result)).toBe(true);
    });
  });

  describe('failure injection', () => {
    it('90000004 surfaces an HTTP error as unanswered', async () => {
      const result = await ccd.lookup('90000004');
      expect(result.kind).toBe('UNANSWERED');
      expect(result.status).toBe('ERROR');
      expect(isSourceAvailable(result)).toBe(false);
    });
  });

  describe('money never becomes a float in the adapter path', () => {
    it('carries paid capital as a 3-dp string', async () => {
      const result = await ccd.lookup('20000101');
      if (result.kind !== 'ANSWERED') throw new Error('unreachable');
      expect(result.normalized.paidCapitalJod).toBe('50000.000');
      expect(typeof result.normalized.paidCapitalJod).toBe('string');
    });
  });
});

describe('ResilientGovernmentAdapter', () => {
  /** A controllable inner adapter, so retries and timeouts are exact. */
  class ScriptedAdapter implements GovernmentAdapter {
    readonly source = 'CCD' as const;
    readonly version = 'scripted';
    calls = 0;
    constructor(private readonly script: (call: number) => Promise<GovernmentLookupResult>) {}
    async lookup(): Promise<GovernmentLookupResult> {
      this.calls += 1;
      return this.script(this.calls);
    }
  }

  const answered = (): GovernmentLookupResult => ({
    kind: 'ANSWERED',
    status: 'SUCCESS',
    raw: {},
    normalized: { legalNameEn: 'Test' },
    expectedFields: ['legalNameEn'],
  });

  const unanswered = (): GovernmentLookupResult => ({
    kind: 'UNANSWERED',
    status: 'UNAVAILABLE',
    errorCode: 'SOURCE_UNAVAILABLE',
    errorMessage: 'down',
  });

  const options: ResilienceOptions = { ...DEFAULT_RESILIENCE, backoffMs: 0, timeoutMs: 50 };
  const noSleep = async (): Promise<void> => undefined;
  let clock = 0;
  const nowMs = (): number => clock;

  beforeEach(() => {
    clock = 0;
  });

  it('retries an unanswered source up to the attempt limit', async () => {
    const inner = new ScriptedAdapter(async (call) => (call < 3 ? unanswered() : answered()));
    const adapter = new ResilientGovernmentAdapter(inner, options, nowMs, noSleep);
    const result = await adapter.lookup('20000101');
    expect(result.kind).toBe('ANSWERED');
    expect(inner.calls).toBe(3);
  });

  it('does NOT retry a NOT_FOUND — the source answered', async () => {
    const inner = new ScriptedAdapter(async () => ({
      kind: 'ANSWERED',
      status: 'NOT_FOUND',
      raw: {},
      normalized: {},
      expectedFields: ['legalNameEn'],
    }));
    const adapter = new ResilientGovernmentAdapter(inner, options, nowMs, noSleep);
    const result = await adapter.lookup('90000002');
    expect(result.status).toBe('NOT_FOUND');
    // Retrying would turn a definitive adverse answer into an availability
    // problem — hard rule 7 in the other direction.
    expect(inner.calls).toBe(1);
  });

  it('gives up as UNANSWERED, never as an adverse finding', async () => {
    const inner = new ScriptedAdapter(async () => unanswered());
    const adapter = new ResilientGovernmentAdapter(inner, options, nowMs, noSleep);
    const result = await adapter.lookup('90000001');
    expect(inner.calls).toBe(options.maxAttempts);
    expect(result.kind).toBe('UNANSWERED');
    expect(isAdverseFinding(result)).toBe(false);
    expect(dataAvailabilityOf(result)).toBe(0);
  });

  it('times out a hanging source as unavailable rather than hanging the request', async () => {
    const inner = new ScriptedAdapter(
      () => new Promise<GovernmentLookupResult>(() => undefined), // never settles
    );
    const adapter = new ResilientGovernmentAdapter(
      inner,
      { ...options, maxAttempts: 1, timeoutMs: 20 },
      nowMs,
      noSleep,
    );
    const result = await adapter.lookup('90000005');
    expect(result.kind).toBe('UNANSWERED');
    if (result.kind !== 'UNANSWERED') throw new Error('unreachable');
    expect(result.errorCode).toBe('SOURCE_TIMEOUT');
  });

  it('converts a thrown adapter error into an unanswered result', async () => {
    const inner = new ScriptedAdapter(async () => {
      throw new Error('socket hang up');
    });
    const adapter = new ResilientGovernmentAdapter(inner, { ...options, maxAttempts: 1 }, nowMs, noSleep);
    const result = await adapter.lookup('20000101');
    expect(result.kind).toBe('UNANSWERED');
    if (result.kind !== 'UNANSWERED') throw new Error('unreachable');
    expect(result.errorCode).toBe('ADAPTER_EXCEPTION');
    // A registry outage must not become a 500 on an onboarding request.
    expect(result.errorMessage).toContain('socket hang up');
  });

  it('opens the circuit after repeated failures and then fails fast', async () => {
    const inner = new ScriptedAdapter(async () => unanswered());
    const adapter = new ResilientGovernmentAdapter(inner, options, nowMs, noSleep);

    await adapter.lookup('90000001'); // 3 attempts → 3 failures
    await adapter.lookup('90000001'); // 3 more; threshold of 5 crossed
    expect(adapter.circuitState()).toBe('OPEN');

    const callsBefore = inner.calls;
    const result = await adapter.lookup('90000001');
    if (result.kind !== 'UNANSWERED') throw new Error('unreachable');
    expect(result.errorCode).toBe('CIRCUIT_OPEN');
    // Short-circuited: the inner adapter was not called at all.
    expect(inner.calls).toBe(callsBefore);
  });

  it('recovers through HALF_OPEN once the reset window passes', async () => {
    let healthy = false;
    const inner = new ScriptedAdapter(async () => (healthy ? answered() : unanswered()));
    const adapter = new ResilientGovernmentAdapter(inner, options, nowMs, noSleep);

    await adapter.lookup('90000001');
    await adapter.lookup('90000001');
    expect(adapter.circuitState()).toBe('OPEN');

    clock += options.circuitResetMs + 1;
    healthy = true;
    const result = await adapter.lookup('20000101');
    expect(result.kind).toBe('ANSWERED');
    expect(adapter.circuitState()).toBe('CLOSED');
  });

  it('an open circuit still reads as unavailable, not as an adverse finding', async () => {
    const inner = new ScriptedAdapter(async () => unanswered());
    const adapter = new ResilientGovernmentAdapter(inner, options, nowMs, noSleep);
    await adapter.lookup('90000001');
    await adapter.lookup('90000001');
    const result = await adapter.lookup('90000001');
    expect(isSourceAvailable(result)).toBe(false);
    expect(isAdverseFinding(result)).toBe(false);
    expect(dataAvailabilityOf(result)).toBe(0);
  });
});
