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
import { FundingService, SettlementRow } from './funding.service';
import { MarkSentDto } from './dto';
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

@ApiTags('Funding')
@Controller()
export class FundingController {
  constructor(private readonly funding: FundingService) {}

  @Post('transactions/:id/funding/mark-sent')
  @HttpCode(HttpStatus.OK)
  // Contract global rule 4: this changes financial state, so the header is
  // required and the interceptor enforces it.
  @Idempotent()
  @RequireRoles('BANK_OPERATIONS', 'BANK_ADMIN')
  @ApiOperation({
    summary: 'Bank marks the transfer executed — does NOT set FUNDED',
    description:
      'Creates the settlement from the immutable accepted-offer snapshot (idempotency key = ' +
      'settlement id, INV-13), records the bank evidence, posts the funding-received ledger ' +
      'journal, and moves the transaction to FUNDING_CONFIRMATION_PENDING. Reaching FUNDED ' +
      'additionally requires the supplier to confirm the one-time code (INV-10), so this ' +
      'endpoint cannot complete funding on its own.',
  })
  @ApiResponse({ status: 200, description: 'Marked sent; awaiting supplier confirmation' })
  @ApiResponse({ status: 409, description: 'Not contracted, or already marked sent' })
  async markSent(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkSentDto,
  ): Promise<Record<string, unknown>> {
    const settlement = await this.funding.markSent(id, contextOf(user, membership), body);
    return describeSettlement(settlement);
  }

  @Get('transactions/:id/settlement')
  @ApiOperation({
    summary: 'The settlement for a transaction',
    description:
      'Gross, the deductions withheld from it, and the net payout — with the provider ' +
      'reference and the current payout status.',
  })
  @ApiResponse({ status: 200, description: 'Settlement' })
  @ApiResponse({ status: 404, description: 'No settlement exists yet' })
  async settlement(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    // Visibility is the same rule as the contract's: the two parties and the
    // platform. requireBankParty covers the bank and platform; a supplier
    // reaches it through the transaction it owns.
    await this.funding.requireSettlementVisible(id, ctx);

    const settlement = await this.funding.findSettlement(id);
    if (!settlement) throw AppException.notFound('Settlement');
    return describeSettlement(settlement);
  }
}

/**
 * Allow-list, like every other payload in this API.
 *
 * `idempotency_key` is deliberately absent: it equals the settlement id, so
 * publishing it would add nothing, and an internal retry key is not part of
 * the contract's Settlement shape.
 */
function describeSettlement(settlement: SettlementRow): Record<string, unknown> {
  return {
    id: settlement.id,
    transactionId: settlement.transaction_id,
    status: settlement.status,
    grossFundingAmount: settlement.gross_funding_amount,
    platformCommissionAmount: settlement.platform_commission_amount,
    listingFeeDeducted: settlement.listing_fee_deducted,
    netSupplierPayout: settlement.net_supplier_payout,
    providerName: settlement.provider_name,
    providerReference: settlement.provider_reference,
    bankMarkedSentAt: settlement.bank_marked_sent_at?.toISOString() ?? null,
    fundingReceivedAt: settlement.funding_received_at?.toISOString() ?? null,
    payoutInitiatedAt: settlement.payout_initiated_at?.toISOString() ?? null,
    payoutCompletedAt: settlement.payout_completed_at?.toISOString() ?? null,
    retryCount: settlement.retry_count,
    failureReason: settlement.failure_reason,
  };
}
