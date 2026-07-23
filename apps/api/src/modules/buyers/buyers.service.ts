import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { GovernmentService } from '../government/government.service';
import { ActorContext } from '../onboarding/onboarding.service';
import {
  BuyerCandidate,
  RegistryStatusValue,
  isBlockingStatus,
  needsManualReview,
  resolutionStatusFor,
} from './buyer-policy';

/**
 * Buyer search and resolution (requirements §7).
 *
 * Two rules shape everything here, and both are the kind that a convenience
 * feature quietly breaks:
 *
 *   ZM-BUY-009  The platform MUST NOT automatically select a buyer based on
 *               name similarity alone, **under any circumstances**. Search
 *               returns candidates; only `/buyers/resolve` with an explicit
 *               `confirmedByUser` creates a link. There is deliberately no
 *               code path in this file that picks one candidate for the
 *               supplier, not even when exactly one matches perfectly.
 *
 *   ZM-BUY-005/008  Contact details belong to the *relationship*, never to
 *               the global `Buyer`. Two suppliers legitimately hold
 *               different contacts at the same company, and writing one
 *               supplier's contact onto the shared row would leak it to the
 *               other and overwrite theirs.
 */

export interface BuyerRow {
  id: string;
  national_establishment_no: string | null;
  legal_company_name: string;
  company_type: string | null;
  registry_status: RegistryStatusValue;
  governorate: string | null;
  registered_address: string | null;
  registration_date: string | null;
  last_verified_at: Date | null;
}

export interface BuyerContactInput {
  contactName: string;
  contactRole: string;
  contactPhone: string;
  contactEmail?: string;
}

@Injectable()
export class BuyersService {
  private readonly logger = new Logger(BuyersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly government: GovernmentService,
  ) {}

  // ------------------------------------------------------------------
  // Search (§7.3 steps 1-4)
  // ------------------------------------------------------------------

  /**
   * Search in the order the requirements prescribe: this supplier's own
   * buyers, then all platform buyers, then the CCD registry.
   *
   * The order is not a performance optimisation — it is what makes the
   * result set meaningful. A buyer this supplier already trades with is a
   * different kind of match from a name the registry happens to return, and
   * `matchSource` carries that distinction to the UI so the supplier can
   * see which is which before choosing.
   *
   * `requiresManualReview` is set when the result is ambiguous (ZM-BUY-010).
   * It never causes a selection to be made; it flags that a human should
   * look, which is the opposite thing.
   */
  async search(
    ctx: ActorContext,
    term: string,
  ): Promise<{ candidates: BuyerCandidate[]; requiresManualReview: boolean }> {
    const query = term.trim();
    if (query.length < 2) {
      throw AppException.validation('A search term of at least 2 characters is required.', {
        field: 'q',
      });
    }

    const candidates: BuyerCandidate[] = [];
    const seen = new Set<string>();

    const push = (candidate: BuyerCandidate): void => {
      // Deduplicated on establishment number, which is the global key
      // (ZM-BUY-006). A buyer already linked to this supplier and also
      // returned by the registry is one company, and showing it twice
      // invites the supplier to "choose" between two identical rows.
      const key = candidate.nationalEstablishmentNumber ?? `name:${candidate.legalCompanyName}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    for (const row of await this.searchOwnBuyers(ctx.organizationId, query)) {
      push({ ...this.toCandidate(row), matchSource: 'OWN_RELATIONSHIP' });
    }
    for (const row of await this.searchPlatformBuyers(query)) {
      push({ ...this.toCandidate(row), matchSource: 'PLATFORM' });
    }
    // The registry is queried last and only by establishment number. A
    // name search against CCD is not something the dummy adapter can
    // honestly implement — it is keyed by establishment number, as the real
    // registry is — so a name that is not already known to the platform
    // simply returns no registry candidate rather than a fabricated one.
    const registryCandidate = await this.searchRegistry(query);
    if (registryCandidate) push(registryCandidate);

    const requiresManualReview = needsManualReview(candidates);

    await this.recordAttempt(ctx, query, candidates, requiresManualReview);

    return { candidates, requiresManualReview };
  }

  private async searchOwnBuyers(organizationId: string, term: string): Promise<BuyerRow[]> {
    const { rows } = await this.db.query<BuyerRow>(
      `SELECT b.id, b.national_establishment_no, b.legal_company_name, b.company_type,
              b.registry_status, b.governorate, b.registered_address,
              b.registration_date::text, b.last_verified_at
         FROM buyers b
         JOIN supplier_buyer_relationships r ON r.buyer_id = b.id
        WHERE r.supplier_org_id = $1
          AND (lower(b.legal_company_name) LIKE lower($2) || '%'
               OR b.national_establishment_no = $3)
        ORDER BY b.legal_company_name
        LIMIT 25`,
      [organizationId, term, term],
    );
    return rows;
  }

  private async searchPlatformBuyers(term: string): Promise<BuyerRow[]> {
    const { rows } = await this.db.query<BuyerRow>(
      `SELECT id, national_establishment_no, legal_company_name, company_type,
              registry_status, governorate, registered_address,
              registration_date::text, last_verified_at
         FROM buyers
        WHERE lower(legal_company_name) LIKE lower($1) || '%'
           OR national_establishment_no = $2
        ORDER BY legal_company_name
        LIMIT 25`,
      [term, term],
    );
    return rows;
  }

  /**
   * CCD lookup by establishment number (§7.3 step 3).
   *
   * Recorded as a government request like any other, so a buyer's registry
   * snapshot carries the same provenance as a supplier's.
   */
  private async searchRegistry(term: string): Promise<BuyerCandidate | null> {
    if (!/^\d{8}$/.test(term)) return null;

    const { result } = await this.government.lookup({
      source: 'CCD',
      lookupKey: term,
      subjectType: 'BUYER',
      subjectId: null,
    });

    if (result.kind !== 'ANSWERED' || result.status === 'NOT_FOUND') {
      // Either the registry did not answer, or it answered "no such
      // entity". Neither produces a candidate, and — hard rule 7 — the two
      // are recorded distinctly on the request row even though the search
      // result looks the same to the caller.
      return null;
    }

    return {
      nationalEstablishmentNumber: term,
      legalCompanyName: result.normalized.legalNameEn ?? term,
      companyType: result.normalized.companyType ?? null,
      registryStatus: (result.normalized.registryStatus as RegistryStatusValue) ?? 'UNKNOWN',
      governorate: result.normalized.governorate ?? null,
      matchSource: 'REGISTRY',
      buyerId: null,
    };
  }

  private toCandidate(row: BuyerRow): Omit<BuyerCandidate, 'matchSource'> {
    return {
      nationalEstablishmentNumber: row.national_establishment_no,
      legalCompanyName: row.legal_company_name,
      companyType: row.company_type,
      registryStatus: row.registry_status,
      governorate: row.governorate,
      buyerId: row.id,
    };
  }

  /**
   * Every search is recorded (`buyer_resolution_attempts`), not just the
   * ones that resolve.
   *
   * A supplier who searched three times and gave up is evidence in a later
   * dispute about who they believed they were invoicing, and it is exactly
   * the trail that vanishes if only successful resolutions are stored.
   */
  private async recordAttempt(
    ctx: ActorContext,
    term: string,
    candidates: BuyerCandidate[],
    requiresManualReview: boolean,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO buyer_resolution_attempts
         (supplier_org_id, search_term, candidates, status, selected_by, notes)
       VALUES ($1, $2, $3::jsonb, $4::buyer_resolution_status, $5, $6)`,
      [
        ctx.organizationId,
        term,
        JSON.stringify(candidates),
        resolutionStatusFor(candidates, requiresManualReview),
        ctx.userId,
        `Search returned ${candidates.length} candidate(s).`,
      ],
    );
  }

  // ------------------------------------------------------------------
  // Resolve (§7.3 steps 5-9)
  // ------------------------------------------------------------------

  /**
   * Confirm a buyer and create or link the global record.
   *
   * `confirmedByUser` is required to be true by the contract and re-checked
   * here rather than trusted from validation alone: this is the single
   * place where a buyer becomes attached to a supplier, and ZM-BUY-009's
   * "under any circumstances" deserves a guard at the point of effect, not
   * only at the edge.
   */
  async resolve(
    ctx: ActorContext,
    input: {
      nationalEstablishmentNumber: string;
      confirmedByUser: boolean;
      contact?: BuyerContactInput;
    },
  ): Promise<Record<string, unknown>> {
    if (!input.confirmedByUser) {
      throw AppException.validation(
        'The supplier must explicitly confirm the selected buyer — the platform never selects one.',
        { field: 'confirmedByUser' },
      );
    }

    const establishmentNo = input.nationalEstablishmentNumber.trim();
    if (!/^\d{8}$/.test(establishmentNo)) {
      throw AppException.validation(
        'A Jordanian national establishment number is 8 digits.',
        { field: 'nationalEstablishmentNumber' },
      );
    }

    // Registry lookup happens outside the transaction — a network call to a
    // third party held open across a database transaction is how connection
    // pools die, the same reasoning onboarding's submit uses.
    const { result } = await this.government.lookup({
      source: 'CCD',
      lookupKey: establishmentNo,
      subjectType: 'BUYER',
      subjectId: null,
    });

    if (result.kind === 'UNANSWERED') {
      // The registry did not answer. This is NOT an adverse finding about
      // the buyer and must not read as one — the supplier is told the
      // registry is unreachable and invited to try again.
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'The commercial registry did not respond. This says nothing about the buyer — please try again shortly.',
        HttpStatus.SERVICE_UNAVAILABLE,
        { source: 'CCD', sourceAvailable: false },
      );
    }

    if (result.status === 'NOT_FOUND') {
      // The registry answered, adversely: there is no such entity. A
      // different fact from the branch above, and a different outcome.
      await this.recordResolution(ctx, establishmentNo, null, 'NOT_FOUND', 'Registry has no such entity.');
      throw AppException.notFound('Buyer');
    }

    const registryStatus = (result.normalized.registryStatus as RegistryStatusValue) ?? 'UNKNOWN';

    if (isBlockingStatus(registryStatus)) {
      // SUSPENDED / STRUCK_OFF — the contract declares 409 here. The buyer
      // record is still created or refreshed below in neither case: a
      // blocked buyer must not become linked to the supplier, or the
      // relationship would outlive the block.
      this.logger.warn(
        `Buyer ${establishmentNo} refused to supplier ${ctx.organizationId}: registry status ${registryStatus}.`,
      );
      await this.recordResolution(
        ctx,
        establishmentNo,
        null,
        'BLOCKED',
        `Registry status ${registryStatus}.`,
      );
      throw AppException.conflict(
        ErrorCode.BUYER_BLOCKED,
        this.blockedMessageFor(registryStatus),
        { registryStatus, nationalEstablishmentNumber: establishmentNo },
      );
    }

    return this.db.transaction(async (client) => {
      const buyer = await this.upsertBuyer(client, establishmentNo, result.normalized, registryStatus);

      // LT-02: UNDER_LIQUIDATION is not blocked outright — it goes to manual
      // review. A company in liquidation can still owe money, and the
      // question of whether that receivable is financeable is a judgement,
      // not a rule.
      const underReview = registryStatus === 'UNDER_LIQUIDATION';

      await this.upsertRelationship(client, ctx, buyer.id, input.contact);
      await this.recordResolution(
        ctx,
        establishmentNo,
        buyer.id,
        underReview ? 'MANUAL_REVIEW' : 'MATCHED',
        underReview ? 'Buyer is under liquidation — manual review (LT-02).' : null,
        client,
      );

      return {
        ...this.describe(buyer),
        requiresManualReview: underReview,
      };
    });
  }

  private blockedMessageFor(status: RegistryStatusValue): string {
    // Named plainly and without judgement of the supplier: they did nothing
    // wrong by invoicing a company that was later suspended.
    return status === 'STRUCK_OFF'
      ? 'This buyer has been struck off the commercial register and cannot be financed.'
      : 'This buyer is suspended in the commercial register and cannot be financed at present.';
  }

  /**
   * Create or refresh the global buyer (ZM-BUY-006: one row per national
   * establishment number, platform-wide).
   *
   * Note what is NOT written here: no contact fields. They belong to the
   * relationship, and the `buyers` table has no columns for them precisely
   * so this cannot be got wrong.
   */
  private async upsertBuyer(
    client: PoolClient,
    establishmentNo: string,
    normalized: Record<string, string>,
    registryStatus: RegistryStatusValue,
  ): Promise<BuyerRow> {
    const { rows } = await client.query<BuyerRow>(
      `INSERT INTO buyers
         (national_establishment_no, legal_company_name, company_type, registry_status,
          governorate, registered_address, capital_amount, registration_date, last_verified_at)
       VALUES ($1, $2, $3, $4::buyer_registry_status, $5, $6, $7::numeric, $8::date, now())
       ON CONFLICT (national_establishment_no) DO UPDATE SET
         legal_company_name = EXCLUDED.legal_company_name,
         company_type       = EXCLUDED.company_type,
         registry_status    = EXCLUDED.registry_status,
         governorate        = COALESCE(EXCLUDED.governorate, buyers.governorate),
         registered_address = COALESCE(EXCLUDED.registered_address, buyers.registered_address),
         registration_date  = COALESCE(EXCLUDED.registration_date, buyers.registration_date),
         last_verified_at   = now(),
         updated_at         = now()
       RETURNING id, national_establishment_no, legal_company_name, company_type,
                 registry_status, governorate, registered_address, registration_date::text,
                 last_verified_at`,
      [
        establishmentNo,
        normalized.legalNameEn ?? `Establishment ${establishmentNo}`,
        normalized.companyType ?? null,
        registryStatus,
        normalized.governorate ?? null,
        normalized.premisesAddress ?? null,
        normalized.paidCapitalJod ?? null,
        normalized.registrationDate ?? null,
      ],
    );
    return rows[0];
  }

  /**
   * Create or update this supplier's relationship with the buyer.
   *
   * The phone number is encrypted at rest (ZM-BUY-015) with only the last
   * four digits in the clear, the same treatment supplier IBANs get. The
   * contact state starts at SUPPLIER_PROVIDED and stays there until someone
   * actually contacts them — ZM-BUY-011 is explicit that this is the
   * supplier's claim, not the buyer's official registry contact, and
   * defaulting it to anything stronger would launder one into the other.
   */
  private async upsertRelationship(
    client: PoolClient,
    ctx: ActorContext,
    buyerId: string,
    contact?: BuyerContactInput,
  ): Promise<void> {
    if (!contact) {
      await client.query(
        `INSERT INTO supplier_buyer_relationships (supplier_org_id, buyer_id, provided_by_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (supplier_org_id, buyer_id) DO UPDATE SET updated_at = now()`,
        [ctx.organizationId, buyerId, ctx.userId],
      );
      return;
    }

    const phone = contact.contactPhone.replace(/\s+/g, '');
    await client.query(
      `INSERT INTO supplier_buyer_relationships
         (supplier_org_id, buyer_id, contact_name, contact_role,
          contact_phone_enc, contact_phone_last4, contact_email,
          contact_state, provided_by_user_id)
       VALUES ($1, $2, $3, $4, pgp_sym_encrypt($5, $6), $7, $8, 'SUPPLIER_PROVIDED', $9)
       ON CONFLICT (supplier_org_id, buyer_id) DO UPDATE SET
         contact_name        = EXCLUDED.contact_name,
         contact_role        = EXCLUDED.contact_role,
         contact_phone_enc   = EXCLUDED.contact_phone_enc,
         contact_phone_last4 = EXCLUDED.contact_phone_last4,
         contact_email       = EXCLUDED.contact_email,
         provided_by_user_id = EXCLUDED.provided_by_user_id,
         updated_at          = now()`,
      [
        ctx.organizationId,
        buyerId,
        contact.contactName,
        contact.contactRole,
        phone,
        this.config.encryptionKey,
        phone.slice(-4),
        contact.contactEmail ?? null,
        ctx.userId,
      ],
    );
  }

  private async recordResolution(
    ctx: ActorContext,
    term: string,
    buyerId: string | null,
    status: string,
    notes: string | null,
    client?: PoolClient,
  ): Promise<void> {
    const sql = `INSERT INTO buyer_resolution_attempts
         (supplier_org_id, search_term, candidates, selected_buyer_id, selected_by, status, notes)
       VALUES ($1, $2, '[]'::jsonb, $3, $4, $5::buyer_resolution_status, $6)`;
    const params = [ctx.organizationId, term, buyerId, ctx.userId, status, notes];
    if (client) {
      await client.query(sql, params);
      return;
    }
    await this.db.query(sql, params);
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  /**
   * A single buyer.
   *
   * Visible to platform staff, and to a supplier that has a relationship
   * with this buyer. Anyone else gets 404 rather than 403 — the same
   * enumeration-oracle reasoning the onboarding and government reads use.
   * Buyers are global records, so without this a supplier could walk the
   * whole buyer table by id.
   */
  async getForCaller(id: string, ctx: ActorContext): Promise<Record<string, unknown>> {
    const row = await this.db.queryOne<BuyerRow>(
      `SELECT id, national_establishment_no, legal_company_name, company_type,
              registry_status, governorate, registered_address, registration_date::text,
              last_verified_at
         FROM buyers WHERE id = $1`,
      [id],
    );
    if (!row) throw AppException.notFound('Buyer');

    if (ctx.organizationType !== 'PLATFORM') {
      const related = await this.db.queryOne(
        `SELECT 1 FROM supplier_buyer_relationships
          WHERE supplier_org_id = $1 AND buyer_id = $2 LIMIT 1`,
        [ctx.organizationId, id],
      );
      if (!related) throw AppException.notFound('Buyer');
    }

    return this.describe(row);
  }

  /** Contract `Buyer` shape. No contact data — that is relationship-scoped. */
  describe(row: BuyerRow): Record<string, unknown> {
    return {
      id: row.id,
      nationalEstablishmentNumber: row.national_establishment_no,
      legalCompanyName: row.legal_company_name,
      registryStatus: row.registry_status,
      governorate: row.governorate,
      registeredAddress: row.registered_address,
      // Selected as ::text. A Postgres `date` read as a JS Date lands on
      // LOCAL midnight, so toISOString() moves it to the previous day in
      // any timezone ahead of UTC — Asia/Amman included.
      registrationDate: row.registration_date,
      lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    };
  }

  /** Used by the transactions module when linking a buyer. */
  async findById(id: string): Promise<BuyerRow | null> {
    return this.db.queryOne<BuyerRow>(
      `SELECT id, national_establishment_no, legal_company_name, company_type,
              registry_status, governorate, registered_address, registration_date::text,
              last_verified_at
         FROM buyers WHERE id = $1`,
      [id],
    );
  }

  /**
   * The same rows as `findById`, for a set of ids, in one query.
   *
   * Exists so a list endpoint can resolve every row's buyer without a query
   * per row. `= ANY($1::uuid[])` is one round trip whatever the length, which
   * is the difference between a list that scales and one that fires a query
   * per item and falls over on a busy connection pool.
   */
  async findByIds(ids: readonly string[]): Promise<Map<string, BuyerRow>> {
    const map = new Map<string, BuyerRow>();
    if (ids.length === 0) return map;
    const { rows } = await this.db.query<BuyerRow>(
      `SELECT id, national_establishment_no, legal_company_name, company_type,
              registry_status, governorate, registered_address, registration_date::text,
              last_verified_at
         FROM buyers WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  async hasRelationship(supplierOrgId: string, buyerId: string): Promise<boolean> {
    const row = await this.db.queryOne(
      `SELECT 1 FROM supplier_buyer_relationships
        WHERE supplier_org_id = $1 AND buyer_id = $2 LIMIT 1`,
      [supplierOrgId, buyerId],
    );
    return row !== null;
  }

  async linkToTransaction(
    ctx: ActorContext,
    buyerId: string,
    contact?: BuyerContactInput,
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      await this.upsertRelationship(client, ctx, buyerId, contact);
    });
  }
}
