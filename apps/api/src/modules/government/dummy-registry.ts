/**
 * The dummy government registry.
 *
 * Every identity here is copied from `docs/specs/GOV_DUMMY_DATA.md`, which
 * is the shared contract with Agent B: their MSW fixtures mirror the same
 * names and numbers so a mock→live swap is visually diffable and any
 * difference is a real bug rather than a fixture mismatch. **That file is
 * frozen for renames and renumbering from Phase 2 onward** — adding an
 * identity is fine and must be announced in the daily log; changing one
 * silently breaks Agent B's build.
 *
 * Lookups are keyed by national establishment number and are entirely
 * deterministic. "The registry is down" has to be a reproducible test, not
 * a timing accident, which is what the 9000xxxx failure-injection keys are
 * for (§5 of the spec).
 */

export type RegistryStatus =
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'STRUCK_OFF'
  | 'UNDER_LIQUIDATION'
  | 'UNKNOWN';

/**
 * Company legal form. Sole proprietorships are ineligible for the platform
 * (ZM-SON-012/013): the receivable financing product requires a legal
 * person distinct from the owner.
 */
export type CompanyType =
  | 'LIMITED_LIABILITY'
  | 'PRIVATE_SHAREHOLDING'
  | 'PUBLIC_SHAREHOLDING'
  | 'GENERAL_PARTNERSHIP'
  | 'SOLE_PROPRIETORSHIP';

export interface RegistryEntity {
  establishmentNumber: string;
  legalNameEn: string;
  legalNameAr: string;
  companyType: CompanyType;
  registryStatus: RegistryStatus;
  governorate: string;
  sector: string;
  /** CCD registration. */
  commercialRegistrationNo: string;
  registrationDate: string;
  paidCapitalJod: string;
  /** ISTD. */
  taxNumber: string;
  taxStatus: 'REGISTERED' | 'NOT_REGISTERED' | 'DEREGISTERED';
  vatRegistered: boolean;
  lastFilingPeriod: string;
  /** GAM. */
  professionLicenceNumber: string;
  licenceStatus: 'VALID' | 'EXPIRED' | 'SUSPENDED';
  licenceExpiryDate: string;
  premisesAddress: string;
  activityCode: string;
}

/**
 * Per-source behaviour overrides for an identity.
 *
 * `docs/specs/GOV_DUMMY_DATA.md` §2 assigns each supplier a registry
 * behaviour — S2 is "CCD full, GAM partial", S3 is "ISTD unavailable" and
 * drives the SLA-pause scenario. Encoding that per identity rather than per
 * test keeps the demo script and the test suite reading from one place.
 */
export type SourceBehaviour = 'FULL' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_FOUND';

export interface RegistryRecord {
  entity: RegistryEntity;
  behaviour: Partial<Record<'CCD' | 'ISTD' | 'GAM' | 'EINVOICE', SourceBehaviour>>;
}

const entity = (e: Partial<RegistryEntity> & Pick<RegistryEntity, 'establishmentNumber' | 'legalNameEn' | 'legalNameAr'>): RegistryEntity => ({
  companyType: 'LIMITED_LIABILITY',
  registryStatus: 'ACTIVE',
  governorate: 'Amman',
  sector: 'Wholesale',
  commercialRegistrationNo: `CR-${e.establishmentNumber}`,
  registrationDate: '2018-03-14',
  paidCapitalJod: '50000.000',
  taxNumber: `TAX-${e.establishmentNumber}`,
  taxStatus: 'REGISTERED',
  vatRegistered: true,
  lastFilingPeriod: '2026-Q1',
  professionLicenceNumber: `GAM-${e.establishmentNumber}`,
  licenceStatus: 'VALID',
  licenceExpiryDate: '2027-01-31',
  premisesAddress: 'Wadi Saqra Street, Amman',
  activityCode: '4690',
  ...e,
});

/** Suppliers (`2000xxxx`) — GOV_DUMMY_DATA §2. */
const SUPPLIERS: RegistryRecord[] = [
  {
    // S1 — the demo's protagonist. Every source answers in full.
    entity: entity({
      establishmentNumber: '20000101',
      legalNameEn: 'Al-Noor Trading Company',
      legalNameAr: 'شركة النور للتجارة',
      governorate: 'Amman',
      sector: 'Wholesale',
    }),
    behaviour: { CCD: 'FULL', ISTD: 'FULL', GAM: 'FULL' },
  },
  {
    // S2 — CCD full, GAM partial.
    entity: entity({
      establishmentNumber: '20000102',
      legalNameEn: 'Petra Industrial Supplies',
      legalNameAr: 'بتراء للتوريدات الصناعية',
      governorate: 'Zarqa',
      sector: 'Manufacturing',
      activityCode: '2599',
      premisesAddress: 'Industrial Zone, Zarqa',
    }),
    behaviour: { CCD: 'FULL', ISTD: 'FULL', GAM: 'PARTIAL' },
  },
  {
    // S3 — ISTD unavailable. This is the identity the SLA-pause scenario and
    // the GOVERNMENT_SERVICE_UNAVAILABLE state are demonstrated with.
    entity: entity({
      establishmentNumber: '20000103',
      legalNameEn: 'Jordan Valley Foods',
      legalNameAr: 'أغذية وادي الأردن',
      governorate: 'Irbid',
      sector: 'Food',
      activityCode: '1030',
      premisesAddress: 'Irbid Ring Road, Irbid',
    }),
    behaviour: { CCD: 'FULL', ISTD: 'UNAVAILABLE', GAM: 'FULL' },
  },
  {
    // S4 — added in Phase 2 for ZM-SON-012/013. A sole proprietorship is
    // hard-rejected at automated verification, and that path could not be
    // demonstrated or tested without an identity that is one. Announced in
    // the daily log; nothing existing was renamed or renumbered.
    entity: entity({
      establishmentNumber: '20000104',
      legalNameEn: 'Hani Auto Parts Establishment',
      legalNameAr: 'مؤسسة هاني لقطع غيار السيارات',
      companyType: 'SOLE_PROPRIETORSHIP',
      governorate: 'Amman',
      sector: 'Retail',
      paidCapitalJod: '5000.000',
      activityCode: '4530',
    }),
    behaviour: { CCD: 'FULL', ISTD: 'FULL', GAM: 'FULL' },
  },
  {
    // S5 — added in Phase 2. Every other full-success supplier identity is
    // already seeded as an organization, so `POST /onboarding/register`
    // returns 409 for all of them and the register → submit → approve flow
    // — the Phase 2 integration checkpoint — had no identity it could run
    // on. S5 exists to be registered, so it is deliberately NOT seeded as
    // an organization. Announced in the daily log.
    entity: entity({
      establishmentNumber: '20000105',
      legalNameEn: 'Amman Steel Works',
      legalNameAr: 'أعمال عمان للحديد',
      governorate: 'Amman',
      sector: 'Manufacturing',
      activityCode: '2410',
      premisesAddress: 'Sahab Industrial City, Amman',
    }),
    behaviour: { CCD: 'FULL', ISTD: 'FULL', GAM: 'FULL' },
  },
];

/** Buyers (`3000xxxx`) — GOV_DUMMY_DATA §3. B4-B6 carry blocked statuses. */
const BUYERS: RegistryRecord[] = [
  ['30000201', 'Amman Retail Group', 'مجموعة عمان للتجزئة', 'ACTIVE'],
  ['30000202', 'Levant Construction Co.', 'شركة الشام للإنشاءات', 'ACTIVE'],
  ['30000203', 'Aqaba Logistics Ltd', 'العقبة للخدمات اللوجستية', 'ACTIVE'],
  ['30000204', 'Northern Textiles', 'المنسوجات الشمالية', 'SUSPENDED'],
  ['30000205', 'Desert Rose Trading', 'وردة الصحراء للتجارة', 'STRUCK_OFF'],
  ['30000206', 'Capital Medical Supplies', 'العاصمة للتوريدات الطبية', 'UNDER_LIQUIDATION'],
].map(([establishmentNumber, legalNameEn, legalNameAr, registryStatus]) => ({
  entity: entity({
    establishmentNumber,
    legalNameEn,
    legalNameAr,
    registryStatus: registryStatus as RegistryStatus,
  }),
  behaviour: { CCD: 'FULL' as SourceBehaviour, ISTD: 'FULL' as SourceBehaviour, GAM: 'FULL' as SourceBehaviour },
}));

/** Banks (`4000xxxx`) and the platform org — GOV_DUMMY_DATA §4, §7. */
const BANKS: RegistryRecord[] = [
  ['40000301', 'Jordan National Bank', 'البنك الوطني الأردني'],
  ['40000302', 'Levant Commercial Bank', 'بنك الشام التجاري'],
  ['40000303', 'Capital Investment Bank', 'بنك العاصمة للاستثمار'],
  ['40000001', 'Zimmamless Platform', 'منصة زمم'],
].map(([establishmentNumber, legalNameEn, legalNameAr]) => ({
  entity: entity({
    establishmentNumber,
    legalNameEn,
    legalNameAr,
    companyType: 'PUBLIC_SHAREHOLDING',
    sector: 'Financial services',
  }),
  behaviour: { CCD: 'FULL' as SourceBehaviour, ISTD: 'FULL' as SourceBehaviour, GAM: 'FULL' as SourceBehaviour },
}));

const BY_NUMBER: ReadonlyMap<string, RegistryRecord> = new Map(
  [...SUPPLIERS, ...BUYERS, ...BANKS].map((r) => [r.entity.establishmentNumber, r]),
);

/**
 * Failure-injection keys — GOV_DUMMY_DATA §5.
 *
 * `90000001` and `90000002` are the pair the whole of hard rule 7 turns on:
 * one source that did not answer, one source that answered "no such
 * entity". They must never be collapsed into a single "lookup failed"
 * branch, and INV-9's test asserts exactly that.
 */
export interface InjectedFailure {
  behaviour: SourceBehaviour;
  /** Milliseconds of simulated latency before answering. */
  delayMs?: number;
  /** Simulates an HTTP-level failure from the source. */
  httpError?: boolean;
}

export const FAILURE_KEYS: ReadonlyMap<string, InjectedFailure> = new Map([
  ['90000001', { behaviour: 'UNAVAILABLE' as SourceBehaviour }],
  ['90000002', { behaviour: 'NOT_FOUND' as SourceBehaviour }],
  ['90000003', { behaviour: 'PARTIAL' as SourceBehaviour }],
  ['90000004', { behaviour: 'FULL' as SourceBehaviour, httpError: true }],
  ['90000005', { behaviour: 'FULL' as SourceBehaviour, delayMs: 6000 }],
]);

export function lookupRegistry(establishmentNumber: string): RegistryRecord | null {
  return BY_NUMBER.get(establishmentNumber.trim()) ?? null;
}

export function injectedFailureFor(establishmentNumber: string): InjectedFailure | null {
  return FAILURE_KEYS.get(establishmentNumber.trim()) ?? null;
}

/** Every known identity — used by the seed and by fixture-drift tests. */
export function allRegistryRecords(): readonly RegistryRecord[] {
  return [...SUPPLIERS, ...BUYERS, ...BANKS];
}
