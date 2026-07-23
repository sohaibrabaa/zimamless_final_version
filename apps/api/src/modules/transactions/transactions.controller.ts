import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import {
  CancelTransactionDto,
  DeclarationInputDto,
  InvoiceInputDto,
  LinkBuyerDto,
  MinimumAmountDto,
  RelistRequestDto,
  TransactionListQueryDto,
} from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { CurrentContext, CurrentUser } from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { AppException } from '../../common/errors/app.exception';

/**
 * Receivable transactions (contract /transactions/*).
 *
 * `GET /transactions/{id}` deliberately varies its body by caller role, as
 * the contract states: a supplier and platform staff see
 * `minimumAcceptableAmount`, a bank never does. The audience is decided in
 * the service, alongside the visibility check, so the two cannot drift.
 */
@ApiTags('Transactions')
@Controller()
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  private contextOf(user: PlatformUser, membership: MembershipRow | undefined): ActorContext {
    if (!membership) throw AppException.organizationContextRequired();
    return {
      userId: user.id,
      organizationId: membership.organization_id,
      organizationType: membership.organization_type,
      roles: membership.roles,
    };
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List transactions visible in the active context' })
  @ApiResponse({ status: 200, description: 'Page of transaction summaries' })
  async list(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query() query: TransactionListQueryDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.list(this.contextOf(user, membership), {
      state: query.state,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post('transactions')
  @Audit('TRANSACTION_CREATED', 'RECEIVABLE_TRANSACTION')
  @ApiOperation({ summary: 'Create a draft transaction' })
  @ApiResponse({ status: 201, description: 'Draft created' })
  async create(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
  ): Promise<Record<string, unknown>> {
    return this.transactions.createDraft(this.contextOf(user, membership));
  }

  @Get('transactions/:id')
  @ApiOperation({
    summary: 'Transaction detail',
    description:
      'A supplier and platform staff see minimumAcceptableAmount; a bank never does (INV-8).',
  })
  @ApiResponse({ status: 200, description: 'Transaction' })
  async detail(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const { row, audience } = await this.transactions.requireVisible(
      id,
      this.contextOf(user, membership),
    );
    return this.transactions.describe(row, audience, { includeDetail: true });
  }

  @Put('transactions/:id/invoice')
  @Audit('TRANSACTION_INVOICE_SET', 'INVOICE')
  @ApiOperation({
    summary: 'Set or update invoice details',
    description: 'outstandingAmount is recomputed server-side and never accepted from the client.',
  })
  @ApiResponse({ status: 200, description: 'Invoice' })
  async putInvoice(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: InvoiceInputDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.putInvoice(id, this.contextOf(user, membership), body);
  }

  @Put('transactions/:id/buyer')
  @Audit('TRANSACTION_BUYER_LINKED', 'RECEIVABLE_TRANSACTION')
  @ApiOperation({ summary: 'Link a resolved buyer to the transaction' })
  @ApiResponse({ status: 200, description: 'Linked' })
  @ApiResponse({ status: 409, description: 'Buyer blocked (SUSPENDED / STRUCK_OFF)' })
  async putBuyer(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LinkBuyerDto,
  ): Promise<void> {
    await this.transactions.putBuyer(id, this.contextOf(user, membership), body);
  }

  @Put('transactions/:id/minimum-amount')
  @Audit('TRANSACTION_MINIMUM_AMOUNT_SET', 'RECEIVABLE_TRANSACTION')
  @ApiOperation({
    summary: "Set the supplier's private minimum NET payout floor",
    description: 'Never disclosed to any bank, in any response, error, or log (INV-8).',
  })
  @ApiResponse({ status: 200, description: 'Set' })
  @ApiResponse({ status: 422, description: 'Exceeds the invoice outstanding amount' })
  async putMinimumAmount(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MinimumAmountDto,
  ): Promise<void> {
    await this.transactions.putMinimumAmount(
      id,
      this.contextOf(user, membership),
      body.minimumAcceptableAmount,
    );
  }

  @Post('transactions/:id/declarations')
  @Audit('TRANSACTION_DECLARATIONS_RECORDED', 'INVOICE_DECLARATION')
  @ApiOperation({ summary: 'Record supplier declarations (all must be true)' })
  @ApiResponse({ status: 201, description: 'Recorded' })
  async declarations(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeclarationInputDto,
  ): Promise<void> {
    await this.transactions.recordDeclarations(
      id,
      this.contextOf(user, membership),
      body as unknown as Record<string, boolean | string>,
    );
  }

  @Post('transactions/:id/submit')
  // The contract declares 200 for submit, not POST's default 201.
  @HttpCode(HttpStatus.OK)
  @Audit('TRANSACTION_SUBMITTED', 'RECEIVABLE_TRANSACTION')
  @ApiOperation({ summary: 'Submit for verification' })
  @ApiResponse({ status: 200, description: 'Submitted and verified' })
  @ApiResponse({ status: 409, description: 'Duplicate invoice fingerprint detected' })
  async submit(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.transactions.submit(id, this.contextOf(user, membership));
  }

  @Get('transactions/:id/verification')
  @ApiOperation({ summary: 'The latest verification run and its recorded checks' })
  @ApiResponse({ status: 200, description: 'Verification run' })
  async verification(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.transactions.latestVerification(id, this.contextOf(user, membership));
  }

  @Post('transactions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Audit('TRANSACTION_CANCELLED', 'RECEIVABLE_TRANSACTION')
  @ApiOperation({
    summary: 'Supplier cancels/withdraws a transaction per stage policy (§16.8)',
    description:
      'Cancellable up to and including OPEN_FOR_OFFERS — DRAFT is a soft delete, the review ' +
      'stages are a withdrawal, and an open listing has its live offers closed with it. Once an ' +
      'offer is accepted the counterparty relationship is real, so unwinding it is a case ' +
      'workflow and this returns 409. CANCELLED is a recorded terminal state, never a delete.',
  })
  @ApiResponse({ status: 200, description: 'Cancelled/withdrawn per stage rules' })
  @ApiResponse({ status: 409, description: 'Stage does not permit unilateral cancellation' })
  async cancel(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelTransactionDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.cancel(id, this.contextOf(user, membership), body.reason);
  }

  @Post('transactions/:id/relist-request')
  @HttpCode(HttpStatus.CREATED)
  @Audit('RELISTING_REQUESTED', 'RELISTING_REQUEST')
  @ApiOperation({
    summary: 'Supplier requests a manual relisting (never automatic — ZM-MKT-016)',
    description:
      'Writes a REQUESTED row for the platform to review and approve; it is never an approval ' +
      'in itself. Exactly one open request per transaction — a second while one is open is 409.',
  })
  @ApiResponse({ status: 201, description: 'Relisting request created' })
  @ApiResponse({ status: 409, description: 'An open relisting request already exists' })
  async relistRequest(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RelistRequestDto,
  ): Promise<Record<string, unknown>> {
    return this.transactions.relistRequest(id, this.contextOf(user, membership), body.notes);
  }
}
