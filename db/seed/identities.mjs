/**
 * The Phase 1 seed population.
 *
 * Mirrors docs/specs/GOV_DUMMY_DATA.md exactly — that document is the
 * contract between this seed and Agent B's MSW fixtures, so the two show the
 * same names and numbers and a mock->live swap is visually diffable.
 * Changing a name or number here without changing it there reintroduces
 * precisely the drift the shared identity list exists to prevent.
 */

export const SEED_PASSWORD = 'Zimmamless#2026';

export const ORGANIZATIONS = [
  {
    slug: 'platform',
    type: 'PLATFORM',
    legalName: 'Zimmamless Platform',
    nationalEstablishmentNo: '40000001',
    // The platform itself is operational from day one; it is not onboarded.
    status: 'ACTIVE',
  },
  {
    slug: 'alnoor',
    type: 'SUPPLIER',
    legalName: 'Al-Noor Trading Company',
    legalNameAr: 'شركة النور للتجارة',
    nationalEstablishmentNo: '20000101',
    commercialRegistrationNo: 'CR-20000101',
    taxNumber: 'TAX-20000101',
    // ACTIVE so Agent B can exercise a fully-onboarded supplier from the
    // Phase 1 checkpoint. The onboarding journey itself is Phase 2 and uses
    // Jordan Valley Foods (S3), which this seed deliberately omits.
    status: 'ACTIVE',
  },
  {
    slug: 'petra',
    type: 'SUPPLIER',
    legalName: 'Petra Industrial Supplies',
    legalNameAr: 'بتراء للتوريدات الصناعية',
    nationalEstablishmentNo: '20000102',
    commercialRegistrationNo: 'CR-20000102',
    taxNumber: 'TAX-20000102',
    status: 'ACTIVE',
  },
  {
    slug: 'jnb',
    type: 'BANK',
    legalName: 'Jordan National Bank',
    nationalEstablishmentNo: '40000301',
    bankLicenceNumber: 'CBJ-2019-011',
    swiftCode: 'JNBAJOAX',
    status: 'ACTIVE',
  },
  {
    slug: 'lcb',
    type: 'BANK',
    legalName: 'Levant Commercial Bank',
    nationalEstablishmentNo: '40000302',
    bankLicenceNumber: 'CBJ-2017-004',
    swiftCode: 'LCBKJOAX',
    status: 'ACTIVE',
  },
  {
    slug: 'cib',
    type: 'BANK',
    legalName: 'Capital Investment Bank',
    nationalEstablishmentNo: '40000303',
    bankLicenceNumber: 'CBJ-2020-022',
    swiftCode: 'CIBKJOAX',
    status: 'ACTIVE',
  },
];

/**
 * One user per persona. `memberships` is a list because multi-org is a
 * first-class case: the org-context switcher is a Phase 1 checkpoint item
 * and cannot be tested with single-org users only.
 */
export const USERS = [
  // --- Supplier: Al-Noor (S1) — the demo's protagonist ------------------
  {
    email: 'owner@alnoor.zimmamless.test',
    fullName: 'Rania Haddad',
    phoneNumber: '+962790000101',
    memberships: [
      { org: 'alnoor', roles: ['SUPPLIER_OWNER', 'SUPPLIER_SIGNATORY'], isAuthorizedSignatory: true },
    ],
  },
  {
    email: 'uploader@alnoor.zimmamless.test',
    fullName: 'Omar Khalil',
    phoneNumber: '+962790000102',
    memberships: [{ org: 'alnoor', roles: ['SUPPLIER_UPLOADER'], isAuthorizedSignatory: false }],
  },

  // --- Supplier: Petra (S2) — the second supplier, for duplicate-invoice
  // and cross-supplier isolation tests -----------------------------------
  {
    email: 'owner@petra.zimmamless.test',
    fullName: 'Yousef Nasser',
    phoneNumber: '+962790000103',
    memberships: [
      { org: 'petra', roles: ['SUPPLIER_OWNER', 'SUPPLIER_SIGNATORY'], isAuthorizedSignatory: true },
    ],
  },

  // --- Bank K1: Jordan National Bank ------------------------------------
  {
    email: 'admin@jnb.zimmamless.test',
    fullName: 'Layla Mansour',
    phoneNumber: '+962790000301',
    memberships: [{ org: 'jnb', roles: ['BANK_ADMIN'], isAuthorizedSignatory: true }],
  },
  {
    email: 'maker@jnb.zimmamless.test',
    fullName: 'Tariq Odeh',
    phoneNumber: '+962790000302',
    memberships: [
      { org: 'jnb', roles: ['BANK_OFFER_MAKER', 'BANK_ANALYST'], isAuthorizedSignatory: false },
    ],
  },
  {
    // Distinct from the maker: ZM-ROL-002 separation is enforced by the DB
    // CHECK chk_maker_approver_differ, so INV-12 needs two real people.
    email: 'approver@jnb.zimmamless.test',
    fullName: 'Nadia Rifai',
    phoneNumber: '+962790000303',
    memberships: [{ org: 'jnb', roles: ['BANK_OFFER_APPROVER'], isAuthorizedSignatory: true }],
  },
  {
    email: 'ops@jnb.zimmamless.test',
    fullName: 'Sami Barakat',
    phoneNumber: '+962790000304',
    memberships: [{ org: 'jnb', roles: ['BANK_OPERATIONS'], isAuthorizedSignatory: false }],
  },

  // --- Bank K2: Levant Commercial Bank ----------------------------------
  // The counterparty in every confidentiality test. INV-11 is the claim
  // that K1 cannot read K2's rows, which one seeded bank cannot prove.
  {
    email: 'maker@lcb.zimmamless.test',
    fullName: 'Huda Salameh',
    phoneNumber: '+962790000305',
    memberships: [{ org: 'lcb', roles: ['BANK_OFFER_MAKER'], isAuthorizedSignatory: false }],
  },
  {
    email: 'approver@lcb.zimmamless.test',
    fullName: 'Faris Zoubi',
    phoneNumber: '+962790000306',
    memberships: [{ org: 'lcb', roles: ['BANK_OFFER_APPROVER'], isAuthorizedSignatory: true }],
  },
  {
    email: 'ops@lcb.zimmamless.test',
    fullName: 'Dina Aql',
    phoneNumber: '+962790000307',
    memberships: [{ org: 'lcb', roles: ['BANK_OPERATIONS'], isAuthorizedSignatory: false }],
  },

  // --- Bank K3: Capital Investment Bank ---------------------------------
  {
    email: 'maker@cib.zimmamless.test',
    fullName: 'Bashar Tell',
    phoneNumber: '+962790000308',
    memberships: [{ org: 'cib', roles: ['BANK_OFFER_MAKER'], isAuthorizedSignatory: false }],
  },

  // --- Platform ---------------------------------------------------------
  {
    email: 'admin@platform.zimmamless.test',
    fullName: 'Zaid Qasem',
    phoneNumber: '+962790000001',
    memberships: [
      {
        org: 'platform',
        roles: ['PLATFORM_SUPER_ADMIN', 'PLATFORM_OPS_ADMIN'],
        isAuthorizedSignatory: true,
      },
    ],
  },
  {
    email: 'reviewer@platform.zimmamless.test',
    fullName: 'Maha Darwish',
    phoneNumber: '+962790000002',
    memberships: [
      { org: 'platform', roles: ['PLATFORM_SUPPLIER_REVIEWER'], isAuthorizedSignatory: false },
    ],
  },
  {
    email: 'compliance@platform.zimmamless.test',
    fullName: 'Khalid Amir',
    phoneNumber: '+962790000003',
    memberships: [{ org: 'platform', roles: ['PLATFORM_COMPLIANCE'], isAuthorizedSignatory: false }],
  },

  // --- Multi-org ---------------------------------------------------------
  // Exists solely so the org-context switcher has something to switch
  // between. Without it, POST /auth/context can only ever be tested against
  // its own failure case.
  {
    email: 'multi@platform.zimmamless.test',
    fullName: 'Sara Yaseen',
    phoneNumber: '+962790000004',
    memberships: [
      { org: 'platform', roles: ['PLATFORM_SUPPORT'], isAuthorizedSignatory: false },
      { org: 'petra', roles: ['SUPPLIER_VIEWER'], isAuthorizedSignatory: false },
    ],
  },
];

/**
 * Buyers are registry records, never platform users. B4-B6 carry blocked
 * registry statuses so Agent B can build the block-state screens in Phase 3
 * without waiting for the buyer-resolution endpoints.
 */
export const BUYERS = [
  { no: '30000201', name: 'Amman Retail Group', status: 'ACTIVE', governorate: 'Amman' },
  { no: '30000202', name: 'Levant Construction Co.', status: 'ACTIVE', governorate: 'Amman' },
  { no: '30000203', name: 'Aqaba Logistics Ltd', status: 'ACTIVE', governorate: 'Aqaba' },
  { no: '30000204', name: 'Northern Textiles', status: 'SUSPENDED', governorate: 'Irbid' },
  { no: '30000205', name: 'Desert Rose Trading', status: 'STRUCK_OFF', governorate: 'Amman' },
  { no: '30000206', name: 'Capital Medical Supplies', status: 'UNDER_LIQUIDATION', governorate: 'Zarqa' },
];
