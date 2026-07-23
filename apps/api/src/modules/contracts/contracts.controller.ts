import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AcceptanceService, type SnapshotRow } from './acceptance.service';
import { ContractsService } from './contracts.service';
import { ConditionsService } from './conditions.service';
import { DatabaseService } from '../../database/database.service';
import { FulfilConditionDto, SignContractDto } from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { CurrentContext, CurrentUser, RequireRoles } from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { AppException } from '../../common/errors/app.exception';

function contextOf(user: PlatformUser, membership: MembershipRow | undefined): ActorContext {
  if (!membership) throw AppException.organizationContextRequired();
  return {
    userId: user.id,
    organizationId: membership.organization_id,
    organizationType: membership.organization_type,
    roles: membership.roles,
  };
}

@ApiTags('Offers')
@Controller()
export class AcceptanceController {
  constructor(
    private readonly acceptance: AcceptanceService,
    private readonly db: DatabaseService,
  ) {}

  @Post('offers/:id/accept')
  @HttpCode(HttpStatus.OK)
  // Contract global rule 4: acceptance moves financial state, so it carries a
  // required Idempotency-Key. The interceptor replays the first response for a
  // repeated key; the service is independently atomic (INV-1), so the two
  // together make a double-accept impossible AND observably identical.
  @Idempotent()
  // AS-01's default. The service re-checks against the configured setting, so
  // widening the policy to SUPPLIER_UPLOADER is a settings change — but the
  // route guard must still list every role the setting could name, or a
  // configured role would be stopped at the door.
  @RequireRoles('SUPPLIER_OWNER', 'SUPPLIER_SIGNATORY', 'SUPPLIER_UPLOADER')
  @ApiOperation({
    summary: 'Accept an offer — ATOMIC AND IRREVERSIBLE',
    description:
      'One database transaction: row-lock the transaction, re-validate the offer, lock it, ' +
      'mark this offer SELECTED and every other ACTIVE offer NOT_SELECTED, write the immutable ' +
      'AcceptedOfferSnapshot with a content hash, audit. Any failure rolls back entirely and a ' +
      'second acceptance is impossible (INV-1..INV-4). Replaying the same acceptance returns ' +
      'the original snapshot without re-executing.',
  })
  @ApiResponse({ status: 200, description: 'Accepted — returns the immutable snapshot' })
  @ApiResponse({ status: 409, description: 'Already locked, or the offer is no longer acceptable' })
  async accept(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.acceptance.accept(id, contextOf(user, membership));
    return this.describeSnapshot(snapshot);
  }

  @Post('listings/:id/reject-all')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('SUPPLIER_OWNER', 'SUPPLIER_SIGNATORY')
  @Audit('OFFERS_REJECTED', 'LISTING')
  @ApiOperation({
    summary: 'Reject all offers — the transaction returns to ELIGIBLE',
    description:
      'The receivable is untouched and may be relisted. Banks are told they were not selected ' +
      'and nothing else.',
  })
  @ApiResponse({ status: 200, description: 'All offers rejected' })
  async rejectAll(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.acceptance.rejectAll(id, contextOf(user, membership));
  }

  /** Allow-list, like every other payload. The bank's NAME, not its id. */
  private async describeSnapshot(snapshot: SnapshotRow): Promise<Record<string, unknown>> {
    const bank = await this.db.queryOne<{ legal_name: string }>(
      `SELECT legal_name FROM organizations WHERE id = $1`,
      [snapshot.bank_org_id],
    );
    return {
      id: snapshot.id,
      transactionId: snapshot.transaction_id,
      bankName: bank?.legal_name ?? null,
      transactionType: snapshot.transaction_type,
      recourseType: snapshot.recourse_type,
      grossFundingAmount: snapshot.gross_funding_amount,
      bankDiscountAmount: snapshot.bank_discount_amount,
      bankFeesAmount: snapshot.bank_fees_amount,
      platformCommissionAmount: snapshot.platform_commission_amount,
      listingFeeAmount: snapshot.listing_fee_amount,
      otherDeductionsAmount: snapshot.other_deductions_amount,
      netSupplierPayout: snapshot.net_supplier_payout,
      conditionsSnapshot: snapshot.conditions_snapshot,
      snapshotHash: snapshot.snapshot_hash,
      capturedAt: snapshot.captured_at.toISOString(),
    };
  }
}

@ApiTags('Contracts')
@Controller()
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly conditions: ConditionsService,
  ) {}

  @Post('transactions/:id/contract')
  @RequireRoles('SUPPLIER_OWNER', 'SUPPLIER_SIGNATORY', 'BANK_ADMIN', 'BANK_OPERATIONS')
  @ApiOperation({
    summary: 'Generate the contract from template + snapshot',
    description:
      'Runs the ZM-CON-006 pre-contract checks first and reports ALL failures at once, not the ' +
      'first. Terms come from the immutable accepted-offer snapshot, never from the live offer.',
  })
  @ApiResponse({ status: 201, description: 'Contract generated, awaiting signatures' })
  @ApiResponse({ status: 409, description: 'Already generated, or no offer has been accepted' })
  @ApiResponse({ status: 422, description: 'Pre-contract checks failed — `details.findings`' })
  async generate(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const contract = await this.contracts.generate(id, contextOf(user, membership));
    return this.contracts.describe(contract);
  }

  @Get('transactions/:id/contract')
  @ApiOperation({ summary: 'The contract for a transaction' })
  @ApiResponse({ status: 200, description: 'Contract' })
  @ApiResponse({ status: 404, description: 'No contract has been generated' })
  async byTransaction(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const contract = await this.contracts.findByTransaction(id);
    if (!contract) throw AppException.notFound('Contract');
    await this.contracts.requireVisible(contract, contextOf(user, membership));
    return this.contracts.describe(contract);
  }

  @Post('contracts/:id/sign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign (authorized signatory only)',
    description:
      'Click-to-accept through the SignatureProvider adapter. The signature is recorded, then ' +
      'verified; only a VERIFIED signature counts toward FULLY_SIGNED (ZM-CON-011/012).',
  })
  @ApiResponse({ status: 200, description: 'Signed and verified' })
  @ApiResponse({ status: 403, description: 'Not an authorized signatory for this contract' })
  async sign(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SignContractDto,
  ): Promise<Record<string, unknown>> {
    const contract = await this.contracts.sign(id, contextOf(user, membership), body.accepted);
    return this.contracts.describe(contract);
  }

  @Get('transactions/:id/conditions')
  @ApiOperation({ summary: 'Conditions on the accepted offer' })
  @ApiResponse({ status: 200, description: 'Conditions (empty before acceptance)' })
  async listConditions(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.conditions.listForTransaction(id, contextOf(user, membership));
    return rows.map((row) => this.conditions.describe(row));
  }

  @Post('conditions/:id/fulfil')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record fulfilment, or (bank only) a waiver',
    description:
      'A supplier records fulfilment with evidence documents. Only the bank that attached a ' +
      'condition may waive it, and a waiver must carry a reason.',
  })
  @ApiResponse({ status: 200, description: 'Recorded' })
  @ApiResponse({ status: 403, description: 'Only the bank may waive its own condition' })
  async fulfil(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FulfilConditionDto,
  ): Promise<Record<string, unknown>> {
    const row = await this.conditions.fulfil(id, contextOf(user, membership), body);
    return this.conditions.describe(row);
  }
}
