import { GovernmentController } from './government.controller';
import { ErrorCode } from '../../common/errors/error-codes';
import type { MembershipRow, PlatformUser } from '../auth/auth.service';

/**
 * The government endpoints' access gate (the Phase 2 audit's security
 * finding): before it existed, any authenticated user could read any
 * company's full registry snapshot by request id, and run lookups on
 * arbitrary establishment numbers.
 *
 * Refusals are 404, never 403 — the same enumeration-oracle stance as
 * applications: a request that is not yours must be indistinguishable from
 * one that does not exist.
 */

const USER = { id: 'user-1' } as PlatformUser;

function membership(type: string, roles: string[], orgId = 'org-1'): MembershipRow {
  return {
    organization_id: orgId,
    organization_type: type,
    roles,
  } as unknown as MembershipRow;
}

const SUPPLIER = membership('SUPPLIER', ['SUPPLIER_OWNER']);
const REVIEWER = membership('PLATFORM', ['PLATFORM_SUPPLIER_REVIEWER'], 'org-platform');

const REQUEST_ROW = {
  id: 'req-1',
  source: 'CCD',
  lookup_key: '20000102',
  subject_type: 'ORGANIZATION',
  subject_id: 'org-2',
  status: 'SUCCESS',
  source_available: true,
  responded_at: null,
};

function makeController(overrides: {
  establishmentNumberOf?: jest.Mock;
  getRequest?: jest.Mock;
  lookup?: jest.Mock;
} = {}) {
  const government = {
    establishmentNumberOf: overrides.establishmentNumberOf ?? jest.fn().mockResolvedValue('20000101'),
    getRequest: overrides.getRequest ?? jest.fn().mockResolvedValue(REQUEST_ROW),
    lookup:
      overrides.lookup ??
      jest.fn().mockResolvedValue({ request: { ...REQUEST_ROW, lookup_key: '20000101' } }),
    snapshotOf: jest.fn().mockResolvedValue(null),
  };
  const onboarding = { resumeIfWaiting: jest.fn().mockResolvedValue(undefined) };
  return {
    controller: new GovernmentController(government as never, onboarding as never),
    government,
    onboarding,
  };
}

describe('POST /government/lookup access', () => {
  it("refuses a supplier looking up another company's establishment number, as 404", async () => {
    const { controller } = makeController();
    await expect(
      controller.lookup(USER, SUPPLIER, { source: 'CCD', lookupKey: '20000102' } as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND, status: 404 });
  });

  it('permits a supplier looking up its own establishment number', async () => {
    const { controller, onboarding } = makeController();
    await expect(
      controller.lookup(USER, SUPPLIER, { source: 'CCD', lookupKey: '20000101' } as never),
    ).resolves.toBeDefined();
    // The lookup is also the outage-recovery hook (the unreachable-path fix).
    expect(onboarding.resumeIfWaiting).toHaveBeenCalledWith('20000101', expect.anything());
  });

  it('permits platform staff to look up any establishment number', async () => {
    const { controller } = makeController();
    await expect(
      controller.lookup(USER, REVIEWER, { source: 'CCD', lookupKey: '20000102' } as never),
    ).resolves.toBeDefined();
  });

  it('refuses EINVOICE by name while no adapter is registered', async () => {
    const { controller } = makeController();
    await expect(
      controller.lookup(USER, REVIEWER, { source: 'EINVOICE', lookupKey: '20000101' } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });
});

describe('GET /government/requests/:id access', () => {
  it("refuses another organization's request with the same 404 as a missing one", async () => {
    const { controller } = makeController();
    await expect(controller.request(USER, SUPPLIER, 'req-1')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
      status: 404,
    });
  });

  it('permits the owner (matched by its own establishment number)', async () => {
    const { controller } = makeController({
      getRequest: jest.fn().mockResolvedValue({ ...REQUEST_ROW, lookup_key: '20000101' }),
    });
    await expect(controller.request(USER, SUPPLIER, 'req-1')).resolves.toBeDefined();
  });

  it('permits the owner (matched by subject organization)', async () => {
    const { controller } = makeController({
      getRequest: jest.fn().mockResolvedValue({ ...REQUEST_ROW, subject_id: 'org-1' }),
    });
    await expect(controller.request(USER, SUPPLIER, 'req-1')).resolves.toBeDefined();
  });

  it('permits platform staff to read any request', async () => {
    const { controller } = makeController();
    await expect(controller.request(USER, REVIEWER, 'req-1')).resolves.toBeDefined();
  });
});
