import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';
import { StorageService } from '../documents/storage.service';
import type { ActorContext } from '../onboarding/onboarding.service';
import { contentHash, documentHash } from './content-hash';
import { preContractFindings, type PreContractFacts } from './pre-contract-checks';
import { render, renderConditions, type MergeFields } from './template-engine';
import {
  SIGNATURE_PROVIDER,
  type SignatureProvider,
  type SignatureRequest,
} from './signature.provider';

/**
 * Contract generation and signing (ZM-CON-001..012).
 *
 * The document is generated from a versioned template and an immutable
 * snapshot, never from the live offer. That distinction is the point of the
 * whole phase: by the time the contract is drawn up, the `bank_offers` row
 * may have been superseded, expired, or revised by a bank that did not win.
 * `accepted_offer_snapshots` is what was agreed, and it is the only source of
 * commercial terms here.
 *
 * ## Signatures happen in two steps, on purpose
 *
 * ZM-CON-011: a signature counts only after verification confirms document
 * integrity, signer identity and signer authority. So `sign` records a
 * `SIGNED` row and then immediately runs `verify`, which promotes it to
 * `VERIFIED` — and only `VERIFIED` rows count toward `FULLY_SIGNED`
 * (ZM-CON-012). With the dummy provider the two are milliseconds apart, but
 * they are separate rows-states rather than one, because with a real provider
 * verification is asynchronous and the state machine must already have a
 * place to put "signed but not yet verified".
 *
 * ## Zimmamless does not sign
 *
 * ZM-CON-013. Two signatures are required — one authorized supplier
 * signatory, one authorized bank signatory — and the platform is not a party.
 * The signature rows are created at generation for exactly those two
 * organizations, so there is never a moment where the set of required
 * signatories is a question someone answers at signing time.
 */

export interface ContractRow {
  id: string;
  transaction_id: string;
  snapshot_id: string;
  contract_number: string;
  template_id: string;
  template_version: string;
  canonical_language: 'EN' | 'AR';
  status: 'GENERATED' | 'PENDING_SIGNATURES' | 'FULLY_SIGNED' | 'ACTIVE' | 'CANCELLED';
  document_id: string | null;
  document_hash: string | null;
  terms_snapshot: Record<string, unknown>;
  generated_at: Date;
  fully_signed_at: Date | null;
}

interface SignatureRow {
  id: string;
  contract_id: string;
  signer_user_id: string;
  signer_org_id: string;
  signer_capacity: 'SUPPLIER_AUTHORIZED_SIGNATORY' | 'BANK_AUTHORIZED_SIGNATORY';
  status: 'PENDING' | 'SIGNED' | 'VERIFIED' | 'FAILED' | 'REVOKED';
  signed_document_hash: string | null;
  signed_at: Date | null;
  verification_result: Record<string, unknown> | null;
  verified_at: Date | null;
}

@Injectable()
export class ContractsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
    @Inject(SIGNATURE_PROVIDER) private readonly signatures: SignatureProvider,
  ) {}

  // =====================================================================
  // Reads
  // =====================================================================

  async findByTransaction(transactionId: string): Promise<ContractRow | null> {
    return this.db.queryOne<ContractRow>(
      `SELECT * FROM contracts WHERE transaction_id = $1`,
      [transactionId],
    );
  }

  async findById(id: string): Promise<ContractRow | null> {
    return this.db.queryOne<ContractRow>(`SELECT * FROM contracts WHERE id = $1`, [id]);
  }

  /**
   * A contract is visible to its two parties and to platform staff.
   *
   * 404 rather than 403 for anyone else, consistently with the rest of the
   * API — a competing bank must not be able to confirm that a deal was
   * contracted at all.
   */
  async requireVisible(contract: ContractRow, ctx: ActorContext): Promise<void> {
    if (ctx.organizationType === 'PLATFORM') return;

    const snapshot = await this.db.queryOne<{
      supplier_org_id: string;
      bank_org_id: string;
    }>(
      `SELECT supplier_org_id, bank_org_id FROM accepted_offer_snapshots WHERE id = $1`,
      [contract.snapshot_id],
    );
    if (
      snapshot?.supplier_org_id === ctx.organizationId ||
      snapshot?.bank_org_id === ctx.organizationId
    ) {
      return;
    }
    throw AppException.notFound('Contract');
  }

  // =====================================================================
  // Generation
  // =====================================================================

  async generate(transactionId: string, ctx: ActorContext): Promise<ContractRow> {
    const existing = await this.findByTransaction(transactionId);
    if (existing) {
      // `contracts.transaction_id` is UNIQUE, so a second generation is a
      // conflict rather than a new version. Regenerating would replace the
      // document a counterparty may already have signed.
      throw AppException.conflict(
        ErrorCode.CONFLICT,
        'A contract has already been generated for this transaction.',
        { contractId: existing.id },
      );
    }

    const context = await this.generationContext(transactionId, ctx);

    // ---- ZM-CON-006, all of it, before anything is written -------------
    const findings = preContractFindings(context.facts);
    if (findings.length > 0) {
      throw AppException.validation(
        'The contract cannot be generated until the outstanding items are resolved.',
        { findings },
      );
    }

    const template = await this.selectTemplate(context.snapshot.transaction_type, 'EN');
    const now = this.time.now();

    const conditions = (context.snapshot.conditions_snapshot as {
      title: string;
      description: string | null;
      isMandatory: boolean;
    }[]) ?? [];

    const contractNumber = await this.nextContractNumber(context.transaction.reference_number);

    const terms = this.termsSnapshot(context, contractNumber, now);
    const fields = this.mergeFields(context, contractNumber, now, conditions);
    const body = render(template.body_template, fields);
    const bytes = Buffer.from(body, 'utf8');
    const hash = documentHash(bytes);

    // Storage happens BEFORE the database transaction. An object written to a
    // bucket cannot be rolled back by Postgres, so the ordering choice is
    // between an orphaned object on failure and a contract row pointing at a
    // document that was never stored. The orphan is strictly better: it is
    // invisible, costs bytes, and is discoverable; a dangling reference is a
    // contract nobody can read.
    const documentId = await this.storeDocument(context, bytes, hash, contractNumber, ctx);

    const contract = await this.db.transaction(async (client) => {
      const { rows } = await client.query<ContractRow>(
        `INSERT INTO contracts
           (transaction_id, snapshot_id, contract_number, template_id, template_version,
            canonical_language, status, document_id, document_hash, terms_snapshot, generated_at)
         VALUES ($1,$2,$3,$4,$5,'EN','PENDING_SIGNATURES',$6,$7,$8::jsonb,$9)
         RETURNING *`,
        [
          transactionId,
          context.snapshot.id,
          contractNumber,
          template.id,
          template.version,
          documentId,
          hash,
          JSON.stringify(terms),
          now,
        ],
      );
      const created = rows[0];

      await this.createSignatureSlots(client, created, context);

      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
         VALUES ('CONTRACT',$1,NULL,'PENDING_SIGNATURES','Contract generated',$2,$3)`,
        [created.id, ctx.userId, now],
      );

      await this.audit.recordIn(client, {
        actionType: 'CONTRACT_GENERATED',
        targetEntityType: 'CONTRACT',
        targetEntityId: created.id,
        previousValue: null,
        newValue: {
          transactionId,
          contractNumber,
          templateVersion: template.version,
          documentHash: hash,
          termsHash: terms.termsHash,
        },
      });

      return created;
    });

    return contract;
  }

  /**
   * Everything generation needs, gathered once.
   *
   * Read outside the write transaction deliberately: these are six reads
   * against a hosted pooler, and holding a transaction open across them would
   * turn a slow query into a lock held over the receivable.
   */
  private async generationContext(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<GenerationContext> {
    const transaction = await this.db.queryOne<{
      id: string;
      reference_number: string;
      state: string;
      supplier_org_id: string;
      buyer_id: string | null;
    }>(
      `SELECT id, reference_number, state, supplier_org_id, buyer_id
         FROM receivable_transactions WHERE id = $1`,
      [transactionId],
    );
    if (!transaction) throw AppException.notFound('Transaction');

    if (ctx.organizationType === 'SUPPLIER' && transaction.supplier_org_id !== ctx.organizationId) {
      throw AppException.notFound('Transaction');
    }

    const snapshot = await this.db.queryOne<{
      id: string;
      bank_org_id: string;
      supplier_org_id: string;
      source_offer_id: string;
      transaction_type: string;
      recourse_type: string;
      gross_funding_amount: string;
      bank_discount_amount: string;
      bank_fees_amount: string;
      platform_commission_amount: string;
      listing_fee_amount: string;
      other_deductions_amount: string;
      net_supplier_payout: string;
      conditions_snapshot: unknown;
      snapshot_hash: string;
      captured_at: Date;
    }>(`SELECT * FROM accepted_offer_snapshots WHERE transaction_id = $1`, [transactionId]);

    if (!snapshot) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'No offer has been accepted for this transaction, so there are no terms to contract.',
        HttpStatus.CONFLICT,
      );
    }

    if (ctx.organizationType === 'BANK' && snapshot.bank_org_id !== ctx.organizationId) {
      throw AppException.notFound('Transaction');
    }

    const invoice = await this.db.queryOne<{
      id: string;
      invoice_number: string;
      einvoice_identifier: string | null;
      issue_date: string;
      due_date: string;
      currency: string;
      face_value: string;
      outstanding_amount: string;
    }>(
      // `invoices` has no status column — cancellation lives on the
      // transaction's state, which is where the fingerprint trigger reads it
      // from too. Asking the invoice would have been asking the wrong row.
      `SELECT id, invoice_number, einvoice_identifier, issue_date::text AS issue_date,
              due_date::text AS due_date, currency, face_value, outstanding_amount
         FROM invoices WHERE transaction_id = $1`,
      [transactionId],
    );
    if (!invoice) throw AppException.validation('The transaction has no invoice.');

    const supplier = await this.party(snapshot.supplier_org_id);
    const bank = await this.party(snapshot.bank_org_id);

    const buyer = transaction.buyer_id
      ? await this.db.queryOne<{
          legal_company_name: string;
          national_establishment_no: string;
        }>(
          `SELECT legal_company_name, national_establishment_no FROM buyers WHERE id = $1`,
          [transaction.buyer_id],
        )
      : null;

    const { rows: conditions } = await this.db.query<{
      id: string;
      title: string;
      is_mandatory: boolean;
      fulfilment: 'PENDING' | 'FULFILLED' | 'WAIVED' | 'FAILED';
      waiver_reason: string | null;
    }>(
      `SELECT id, title, is_mandatory, fulfilment, waiver_reason
         FROM offer_conditions WHERE offer_id = $1 ORDER BY display_order`,
      [snapshot.source_offer_id],
    );

    // `invoice_declarations` is one row of booleans per transaction, not a row
    // per declaration key. "Reconfirmed" therefore means: the row exists and
    // every one of the eight is true. A missing row is NOT treated as
    // affirmed — an absent declaration is the strongest possible reason to
    // refuse, not a default to fall through.
    const declarations = await this.db.queryOne<{ all_affirmed: boolean }>(
      `SELECT (is_authentic AND goods_delivered AND unpaid_and_not_cancelled
               AND no_known_dispute AND not_previously_financed
               AND buyer_is_named_entity AND contact_is_buyer_rep
               AND accepts_recourse) AS all_affirmed
         FROM invoice_declarations WHERE transaction_id = $1`,
      [transactionId],
    );

    const bankAccount = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM supplier_bank_accounts
        WHERE organization_id = $1 AND verification_status = 'VERIFIED'
        LIMIT 1`,
      [snapshot.supplier_org_id],
    );

    const now = this.time.now();

    const facts: PreContractFacts = {
      invoiceOutstanding: Money.from(invoice.outstanding_amount),
      invoiceDueDate: invoice.due_date,
      // The invoice row is the same row the offer was made against — the
      // fingerprint is immutable once submitted — so "altered" here means the
      // invoice was cancelled or superseded, which the status carries.
      invoiceAltered: false,
      invoiceCancelled:
        transaction.state === 'CANCELLED' || transaction.state === 'REJECTED',
      invoiceExpired: Date.parse(`${invoice.due_date}T23:59:59Z`) < now.getTime(),
      snapshotGross: Money.from(snapshot.gross_funding_amount),
      conditions: conditions.map((c) => ({
        id: c.id,
        title: c.title,
        isMandatory: c.is_mandatory,
        fulfilment: c.fulfilment,
        waiverReason: c.waiver_reason,
      })),
      declarationsAffirmed: declarations?.all_affirmed === true,
      bankAccountVerified: bankAccount !== null,
    };

    return { transaction, snapshot, invoice, supplier, bank, buyer, facts };
  }

  private async party(orgId: string): Promise<PartyRow> {
    const row = await this.db.queryOne<PartyRow>(
      `SELECT id, legal_name, national_establishment_no, commercial_registration_no,
              tax_number, bank_licence_number, swift_code
         FROM organizations WHERE id = $1`,
      [orgId],
    );
    if (!row) throw AppException.validation('A party to this transaction no longer exists.');
    return row;
  }

  /**
   * Template selection: exact `transactionType` match, else the default
   * fallback (ZM-CON-002), highest version wins.
   *
   * A missing fallback is a 500-worthy misconfiguration rather than a client
   * error, but it is raised as a plain validation failure with an explicit
   * message, because the person who will read it is an operator and "no
   * contract template is configured" is more useful than a stack trace.
   */
  private async selectTemplate(
    transactionType: string,
    language: 'EN' | 'AR',
  ): Promise<{ id: string; version: string; body_template: string }> {
    const row = await this.db.queryOne<{ id: string; version: string; body_template: string }>(
      `SELECT id, version, body_template
         FROM contract_templates
        WHERE is_active AND language = $2
          AND (transaction_type = $1::transaction_type OR transaction_type IS NULL)
        ORDER BY (transaction_type IS NOT NULL) DESC, version DESC
        LIMIT 1`,
      [transactionType, language],
    );
    if (!row) {
      throw AppException.validation(
        `No active ${language} contract template is configured for ${transactionType}, ` +
          'and no default fallback template exists.',
      );
    }
    return row;
  }

  /** `ZM-C-` + the transaction's own reference, so the two are traceable. */
  private async nextContractNumber(transactionReference: string): Promise<string> {
    return `ZM-C-${transactionReference.replace(/^ZM-?/i, '')}`;
  }

  /**
   * `ContractTermSnapshot` (ZM-CON-005) — every term frozen at generation,
   * with a hash over them.
   *
   * Distinct from the accepted-offer snapshot, and not a copy of it: this one
   * also carries the party identities as they stood at generation and the
   * template version, because "who signed what document, saying what" is the
   * question a dispute asks and the offer snapshot alone cannot answer it.
   */
  private termsSnapshot(
    context: GenerationContext,
    contractNumber: string,
    now: Date,
  ): Record<string, unknown> & { termsHash: string } {
    const { snapshot, invoice, supplier, bank, buyer } = context;

    const terms = {
      contractNumber,
      generatedAt: now.toISOString(),
      canonicalLanguage: 'EN',
      acceptedOfferSnapshotId: snapshot.id,
      acceptedOfferSnapshotHash: snapshot.snapshot_hash,
      supplier: {
        legalName: supplier.legal_name,
        nationalEstablishmentNumber: supplier.national_establishment_no,
        commercialRegistrationNumber: supplier.commercial_registration_no,
        taxNumber: supplier.tax_number,
      },
      bank: {
        legalName: bank.legal_name,
        licenceNumber: bank.bank_licence_number,
        swiftCode: bank.swift_code,
      },
      buyer: buyer
        ? {
            legalCompanyName: buyer.legal_company_name,
            nationalEstablishmentNumber: buyer.national_establishment_no,
          }
        : null,
      invoice: {
        invoiceNumber: invoice.invoice_number,
        einvoiceIdentifier: invoice.einvoice_identifier,
        issueDate: invoice.issue_date,
        dueDate: invoice.due_date,
        currency: invoice.currency,
        faceValue: invoice.face_value,
        outstandingAmount: invoice.outstanding_amount,
      },
      commercial: {
        transactionType: snapshot.transaction_type,
        recourseType: snapshot.recourse_type,
        grossFundingAmount: snapshot.gross_funding_amount,
        bankDiscountAmount: snapshot.bank_discount_amount,
        bankFeesAmount: snapshot.bank_fees_amount,
        platformCommissionAmount: snapshot.platform_commission_amount,
        listingFeeAmount: snapshot.listing_fee_amount,
        otherDeductionsAmount: snapshot.other_deductions_amount,
        netSupplierPayout: snapshot.net_supplier_payout,
      },
      conditions: snapshot.conditions_snapshot,
    };

    return { ...terms, termsHash: contentHash(terms as never) };
  }

  private mergeFields(
    context: GenerationContext,
    contractNumber: string,
    now: Date,
    conditions: { title: string; description: string | null; isMandatory: boolean }[],
  ): MergeFields {
    const { snapshot, invoice, supplier, bank, buyer } = context;
    const dash = '—';

    return {
      'contract.number': contractNumber,
      'contract.generatedAt': now.toISOString().slice(0, 10),
      'contract.canonicalLanguage': 'EN',
      'contract.conditionsHtml': renderConditions(conditions, 'EN'),
      'supplier.legalName': supplier.legal_name,
      'supplier.establishmentNumber': supplier.national_establishment_no ?? dash,
      'supplier.registrationNumber': supplier.commercial_registration_no ?? dash,
      'bank.legalName': bank.legal_name,
      'bank.licenceNumber': bank.bank_licence_number ?? dash,
      'buyer.legalName': buyer?.legal_company_name ?? dash,
      'buyer.establishmentNumber': buyer?.national_establishment_no ?? dash,
      'invoice.number': invoice.invoice_number,
      'invoice.issueDate': invoice.issue_date,
      'invoice.dueDate': invoice.due_date,
      'invoice.currency': invoice.currency,
      'invoice.faceValue': invoice.face_value,
      'invoice.outstandingAmount': invoice.outstanding_amount,
      'terms.transactionType': humanize(snapshot.transaction_type),
      'terms.recourseType': humanize(snapshot.recourse_type),
      'terms.grossFundingAmount': snapshot.gross_funding_amount,
      'terms.bankDiscountAmount': snapshot.bank_discount_amount,
      'terms.bankFeesAmount': snapshot.bank_fees_amount,
      'terms.platformCommissionAmount': snapshot.platform_commission_amount,
      'terms.listingFeeAmount': snapshot.listing_fee_amount,
      'terms.otherDeductionsAmount': snapshot.other_deductions_amount,
      'terms.netSupplierPayout': snapshot.net_supplier_payout,
      'snapshot.hash': snapshot.snapshot_hash,
      'snapshot.capturedAt': snapshot.captured_at.toISOString(),
    };
  }

  private async storeDocument(
    context: GenerationContext,
    bytes: Buffer,
    hash: string,
    contractNumber: string,
    ctx: ActorContext,
  ): Promise<string> {
    const fileName = `${contractNumber}.html`;
    const created = await this.db.queryOne<{ id: string }>(
      `INSERT INTO documents
         (owner_org_id, document_type, storage_path, file_name, mime_type,
          size_bytes, file_hash, subject_type, subject_id, uploaded_by)
       VALUES ($1,'CONTRACT_DOCUMENT','',$2,'text/html',$3,$4,'TRANSACTION',$5,$6)
       RETURNING id`,
      [
        // Owned by the supplier's organization, which is the subject's owner
        // everywhere else in this system. Both parties can read it — the
        // contract's own visibility rule governs that, not the document's
        // owner column.
        context.snapshot.supplier_org_id,
        fileName,
        bytes.byteLength,
        hash,
        context.transaction.id,
        ctx.userId,
      ],
    );
    if (!created) throw new Error('Failed to create the contract document row.');

    const path = this.storage.pathFor(context.snapshot.supplier_org_id, created.id, fileName);
    // Bare `text/html`, with no `; charset=utf-8` parameter. Supabase Storage
    // matches the Content-Type header against the bucket's allow-list as a
    // literal string, so the parameterized form is rejected with
    // `invalid_mime_type` even though the base type is permitted.
    await this.storage.upload(path, bytes, 'text/html');
    await this.db.query(`UPDATE documents SET storage_path = $2 WHERE id = $1`, [
      created.id,
      path,
    ]);
    return created.id;
  }

  /**
   * One PENDING signature slot per required signatory (ZM-CON-010).
   *
   * A row for **every** active member of each organization flagged
   * `is_authorized_signatory`, not one arbitrarily chosen user — because any
   * of them is entitled to sign and the UI has to be able to show who.
   *
   * That is a slot per *eligible* signer, not a slot that must be filled.
   * `settleContractStatus` requires one verified signature per **capacity**,
   * which is ZM-CON-010's default: one supplier signatory, one bank
   * signatory. Read the two together — this method decides who *may* sign,
   * that one decides when enough of them *have*.
   */
  private async createSignatureSlots(
    client: PoolClient,
    contract: ContractRow,
    context: GenerationContext,
  ): Promise<void> {
    for (const [orgId, capacity] of [
      [context.snapshot.supplier_org_id, 'SUPPLIER_AUTHORIZED_SIGNATORY'],
      [context.snapshot.bank_org_id, 'BANK_AUTHORIZED_SIGNATORY'],
    ] as const) {
      const { rows } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM organization_memberships
          WHERE organization_id = $1 AND status = 'ACTIVE' AND is_authorized_signatory
          ORDER BY created_at`,
        [orgId],
      );

      if (rows.length === 0) {
        throw AppException.validation(
          'One of the parties has no authorized signatory, so the contract cannot be signed.',
          { organizationId: orgId },
        );
      }

      for (const row of rows) {
        await client.query(
          `INSERT INTO contract_signatures
             (contract_id, signer_user_id, signer_org_id, signer_capacity, status, provider_name)
           VALUES ($1,$2,$3,$4,'PENDING',$5)`,
          [contract.id, row.user_id, orgId, capacity, this.signatures.name],
        );
      }
    }
  }

  // =====================================================================
  // Signing
  // =====================================================================

  async sign(contractId: string, ctx: ActorContext, accepted: boolean): Promise<ContractRow> {
    const contract = await this.findById(contractId);
    if (!contract) throw AppException.notFound('Contract');
    await this.requireVisible(contract, ctx);

    if (!accepted) {
      // The contract carries `accepted: boolean` and a false is not a
      // signature. Refusing to sign is a real act with real consequences
      // (Phase 8's withdrawal and cancellation cases), so it is not silently
      // treated as a no-op success here.
      throw AppException.validation(
        'Signing requires explicit acceptance. Declining is handled as a cancellation request.',
      );
    }

    if (contract.status === 'FULLY_SIGNED' || contract.status === 'ACTIVE') {
      // Idempotent from the caller's side: a duplicate click on a finished
      // contract returns the contract rather than an error.
      return contract;
    }
    if (contract.status === 'CANCELLED') {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'This contract has been cancelled and can no longer be signed.',
        HttpStatus.CONFLICT,
      );
    }

    const slot = await this.db.queryOne<SignatureRow>(
      `SELECT * FROM contract_signatures WHERE contract_id = $1 AND signer_user_id = $2`,
      [contractId, ctx.userId],
    );
    if (!slot) {
      // ZM-CON-008 + the signatory authorization check: a user with no slot
      // is not a required signatory for this contract. 403 rather than 404 —
      // this caller can already see the contract, so there is nothing left to
      // conceal, and "you may not sign" is the useful answer.
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'You are not an authorized signatory for this contract.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (slot.status === 'VERIFIED') return contract;

    // Authority is re-checked against the membership at signing time, not
    // trusted from the slot: a signatory whose authorization was revoked
    // between generation and signing must not be able to sign.
    const membership = await this.db.queryOne<{ is_authorized_signatory: boolean }>(
      `SELECT is_authorized_signatory FROM organization_memberships
        WHERE user_id = $1 AND organization_id = $2 AND status = 'ACTIVE'`,
      [ctx.userId, slot.signer_org_id],
    );
    const authorized = membership?.is_authorized_signatory === true;

    const signer = await this.db.queryOne<{ full_name: string }>(
      `SELECT full_name FROM users WHERE id = $1`,
      [ctx.userId],
    );

    // The document is re-hashed from storage rather than trusting the stored
    // column: the whole value of a signature is that it binds a person to
    // bytes, and reading the bytes is the only way to know what those are.
    const currentHash = await this.currentDocumentHash(contract);

    const requestContext = RequestContextStore.get();
    const now = this.time.now();

    const request: SignatureRequest = {
      documentHash: currentHash,
      signerUserId: ctx.userId,
      signerOrgId: slot.signer_org_id,
      signerName: signer?.full_name ?? 'Unknown',
      signerCapacity: slot.signer_capacity,
      signerIsAuthorized: authorized,
      signedAt: now,
      ipAddress: requestContext?.ipAddress ?? null,
      deviceInfo: requestContext?.userAgent ?? null,
    };

    const result = await this.signatures.sign(request);
    const verification = await this.signatures.verify({
      signature: result,
      request,
      currentDocumentHash: currentHash,
    });

    return this.db.transaction(async (client) => {
      await client.query(
        `UPDATE contract_signatures
            SET status = $2, provider_name = $3, signed_document_hash = $4, signed_at = $5,
                ip_address = $6::inet, device_info = $7,
                verification_result = $8::jsonb, verified_at = $9
          WHERE id = $1`,
        [
          slot.id,
          // ZM-CON-011: only a verified signature counts. A failed
          // verification is recorded as FAILED rather than discarded — the
          // attempt happened and the evidence of why it failed is the point.
          verification.verified ? 'VERIFIED' : 'FAILED',
          result.providerName,
          result.signedDocumentHash,
          now,
          request.ipAddress,
          request.deviceInfo,
          JSON.stringify({ ...verification, evidence: result.evidence }),
          verification.verified ? now : null,
        ],
      );

      await this.audit.recordIn(client, {
        actionType: verification.verified ? 'CONTRACT_SIGNED' : 'CONTRACT_SIGNATURE_FAILED',
        targetEntityType: 'CONTRACT',
        targetEntityId: contract.id,
        previousValue: { signatureStatus: slot.status },
        newValue: {
          signatureStatus: verification.verified ? 'VERIFIED' : 'FAILED',
          signerCapacity: slot.signer_capacity,
          documentHash: currentHash,
          failureReason: verification.failureReason,
        },
      });

      if (!verification.verified) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          `The signature could not be verified: ${verification.failureReason}.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      return this.settleContractStatus(client, contract, ctx, now);
    });
  }

  /**
   * `FULLY_SIGNED` when the requirement is met (ZM-CON-010/012), and the
   * transaction becomes `CONTRACTED` in the same breath.
   *
   * The requirement is **one verified signature per capacity** — one
   * authorized supplier signatory and one authorized bank signatory — which
   * is ZM-CON-010's stated default, not "every slot verified".
   *
   * The distinction is not academic. A bank with two authorized signatories
   * gets two PENDING slots, because the data model must support multiple
   * signatories per organization and because either of them is entitled to
   * sign. Requiring *both* would hold a contract hostage to whichever
   * colleague happens to be on leave, and it would quietly turn the default
   * into "all", which is not what the requirement says.
   *
   * The unused slots are left `PENDING` rather than being tidied away. That
   * is the honest record: those people did not sign, and a status invented to
   * mean "no longer needed" would be a claim about intent that nobody made.
   * The contract's own `status` is what the UI should drive off.
   */
  private async settleContractStatus(
    client: PoolClient,
    contract: ContractRow,
    ctx: ActorContext,
    now: Date,
  ): Promise<ContractRow> {
    const { rows: byCapacity } = await client.query<{
      signer_capacity: string;
      verified: string;
    }>(
      `SELECT signer_capacity,
              count(*) FILTER (WHERE status = 'VERIFIED')::text AS verified
         FROM contract_signatures
        WHERE contract_id = $1
        GROUP BY signer_capacity`,
      [contract.id],
    );
    // Both capacities must be represented AND each must have at least one
    // verified signature. Checking only "every group has one" would pass a
    // contract that somehow had no bank slot at all.
    const capacities = new Set(byCapacity.map((row) => row.signer_capacity));
    const complete =
      capacities.has('SUPPLIER_AUTHORIZED_SIGNATORY') &&
      capacities.has('BANK_AUTHORIZED_SIGNATORY') &&
      byCapacity.every((row) => Number(row.verified) >= 1);
    if (!complete) {
      const { rows } = await client.query<ContractRow>(
        `SELECT * FROM contracts WHERE id = $1`,
        [contract.id],
      );
      return rows[0];
    }

    const { rows } = await client.query<ContractRow>(
      `UPDATE contracts SET status = 'FULLY_SIGNED', fully_signed_at = $2
        WHERE id = $1 RETURNING *`,
      [contract.id, now],
    );

    const { rows: previous } = await client.query<{ state: string }>(
      `SELECT state FROM receivable_transactions WHERE id = $1`,
      [contract.transaction_id],
    );
    await client.query(
      `UPDATE receivable_transactions SET state = 'CONTRACTED', updated_at = now()
        WHERE id = $1`,
      [contract.transaction_id],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
       VALUES ('TRANSACTION',$1,$2,'CONTRACTED','Contract fully signed',$3,$4)`,
      [contract.transaction_id, previous[0]?.state ?? null, ctx.userId, now],
    );

    await this.audit.recordIn(client, {
      actionType: 'CONTRACT_FULLY_SIGNED',
      targetEntityType: 'CONTRACT',
      targetEntityId: contract.id,
      previousValue: { status: 'PENDING_SIGNATURES' },
      newValue: { status: 'FULLY_SIGNED', transactionState: 'CONTRACTED' },
    });

    return rows[0];
  }

  private async currentDocumentHash(contract: ContractRow): Promise<string> {
    if (!contract.document_id) {
      throw AppException.validation('This contract has no stored document to sign.');
    }
    const document = await this.db.queryOne<{ storage_path: string }>(
      `SELECT storage_path FROM documents WHERE id = $1`,
      [contract.document_id],
    );
    if (!document?.storage_path) {
      throw AppException.validation('The contract document is missing from storage.');
    }
    const bytes = await this.storage.download(document.storage_path);
    if (!bytes) {
      // A signature binds a person to bytes. If the bytes are not there, the
      // honest answer is to refuse rather than to fall back to the stored
      // hash column — which would sign a document nobody can produce.
      throw AppException.validation('The contract document could not be read from storage.');
    }
    return documentHash(bytes);
  }

  // =====================================================================
  // Presentation
  // =====================================================================

  async describe(contract: ContractRow): Promise<Record<string, unknown>> {
    const { rows: signatures } = await this.db.query<{
      full_name: string;
      signer_capacity: string;
      status: string;
      signed_at: Date | null;
    }>(
      `SELECT u.full_name, s.signer_capacity, s.status, s.signed_at
         FROM contract_signatures s JOIN users u ON u.id = s.signer_user_id
        WHERE s.contract_id = $1
        ORDER BY s.signer_capacity, u.full_name`,
      [contract.id],
    );

    return {
      id: contract.id,
      transactionId: contract.transaction_id,
      contractNumber: contract.contract_number,
      status: contract.status,
      templateVersion: contract.template_version,
      canonicalLanguage: contract.canonical_language,
      documentId: contract.document_id,
      documentHash: contract.document_hash,
      termsSnapshot: contract.terms_snapshot,
      signatures: signatures.map((s) => ({
        signerName: s.full_name,
        signerCapacity: s.signer_capacity,
        status: s.status,
        signedAt: s.signed_at?.toISOString() ?? null,
      })),
      generatedAt: contract.generated_at.toISOString(),
      fullySignedAt: contract.fully_signed_at?.toISOString() ?? null,
    };
  }
}

interface PartyRow {
  id: string;
  legal_name: string;
  national_establishment_no: string | null;
  commercial_registration_no: string | null;
  tax_number: string | null;
  bank_licence_number: string | null;
  swift_code: string | null;
}

interface GenerationContext {
  transaction: {
    id: string;
    reference_number: string;
    state: string;
    supplier_org_id: string;
    buyer_id: string | null;
  };
  snapshot: {
    id: string;
    bank_org_id: string;
    supplier_org_id: string;
    source_offer_id: string;
    transaction_type: string;
    recourse_type: string;
    gross_funding_amount: string;
    bank_discount_amount: string;
    bank_fees_amount: string;
    platform_commission_amount: string;
    listing_fee_amount: string;
    other_deductions_amount: string;
    net_supplier_payout: string;
    conditions_snapshot: unknown;
    snapshot_hash: string;
    captured_at: Date;
  };
  invoice: {
    id: string;
    invoice_number: string;
    einvoice_identifier: string | null;
    issue_date: string;
    due_date: string;
    currency: string;
    face_value: string;
    outstanding_amount: string;
  };
  supplier: PartyRow;
  bank: PartyRow;
  buyer: { legal_company_name: string; national_establishment_no: string } | null;
  facts: PreContractFacts;
}

/** `RECEIVABLE_PURCHASE` → `Receivable purchase`, for prose in a document. */
function humanize(value: string): string {
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
