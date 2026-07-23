import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { describeRecourse, RecourseService } from './recourse.service';
import { describeDispute, DisputesService } from './disputes.service';
import { describeWithdrawal, WithdrawalService } from './withdrawal.service';
import { describeFraudCase, FraudService } from './fraud.service';
import { CaseListService, type CaseType } from './case-list.service';
import {
  DecideFraudDto,
  DecideWithdrawalDto,
  InitiateRecourseDto,
  OpenDisputeDto,
  OpenFraudReviewDto,
  OpenWithdrawalDto,
  RecourseStatusDto,
  RepayRecourseDto,
  ResolveDisputeDto,
} from './dto';
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

function audienceOf(ctx: ActorContext): 'SUPPLIER' | 'BANK' | 'PLATFORM' {
  return ctx.organizationType === 'PLATFORM'
    ? 'PLATFORM'
    : ctx.organizationType === 'BANK'
      ? 'BANK'
      : 'SUPPLIER';
}

@ApiTags('Cases')
@Controller()
export class CasesController {
  constructor(
    private readonly recourse: RecourseService,
    private readonly disputes: DisputesService,
    private readonly withdrawals: WithdrawalService,
    private readonly fraud: FraudService,
    private readonly caseList: CaseListService,
  ) {}

  @Post('transactions/:id/recourse')
  @HttpCode(HttpStatus.CREATED)
  @RequireRoles('BANK_OPERATIONS', 'BANK_ADMIN')
  @ApiOperation({
    summary: 'Initiate recourse — BANK ONLY, an admin may not do this',
    description:
      'A platform administrator is refused with 403 even though they outrank the bank. ' +
      'Recourse is a commercial claim between two counterparties, and a platform that could ' +
      'file one on a bank’s behalf would be taking a position in a dispute it is supposed to ' +
      'mediate. The claim is capped at the gross funding amount (ZM-REC-004) and requires a ' +
      'CONFIRMED overdue — an unconfirmed one is not evidence the buyer failed to pay. ' +
      'The platform commission is NOT refunded (ZM-FEE-016).',
  })
  @ApiResponse({ status: 201, description: 'Recourse case opened' })
  @ApiResponse({ status: 403, description: 'Only a bank user may initiate recourse' })
  @ApiResponse({ status: 409, description: 'Not a confirmed overdue, or a case is already open' })
  async initiate(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: InitiateRecourseDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    return describeRecourse(await this.recourse.initiate(id, ctx, body), audienceOf(ctx));
  }

  @Get('recourse/:id')
  @ApiOperation({
    summary: 'A recourse case',
    description:
      'The supplier sees the claim, the amounts and the reason code — enough to respond or ' +
      'dispute. The bank’s free-text notes and the individual who filed it are not part of that.',
  })
  @ApiResponse({ status: 200, description: 'Recourse case' })
  async find(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    return describeRecourse(await this.recourse.findById(id, ctx), audienceOf(ctx));
  }

  @Post('recourse/:id/repay')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Record a repayment against a recourse claim',
    description:
      'Reconciled under a row lock so two repayments arriving together cannot both read the ' +
      'old balance. Settling the claim in full closes the transaction with RECOURSE_SETTLED, ' +
      'so the receivable’s story ends with what actually happened to it. Repaying a settled ' +
      'case returns it unchanged rather than erroring.',
  })
  @ApiResponse({ status: 200, description: 'Recorded' })
  async repay(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RepayRecourseDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    return describeRecourse(await this.recourse.repay(id, ctx, body), audienceOf(ctx));
  }

  @Post('recourse/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Progress a recourse case',
    description:
      'A supplier may move a case to DISPUTED and nothing else — letting the debtor mark a ' +
      'claim SETTLED would let them discharge their own debt. SETTLED is refused while a ' +
      'balance remains, so the case list and the repayment record cannot disagree.',
  })
  @ApiResponse({ status: 200, description: 'Updated' })
  @ApiResponse({ status: 403, description: 'A supplier may only dispute' })
  async progress(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecourseStatusDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    return describeRecourse(await this.recourse.progress(id, ctx, body), audienceOf(ctx));
  }

  // -----------------------------------------------------------------
  // Disputes — ZM-REC-012/013/014
  // -----------------------------------------------------------------

  @Post('transactions/:id/disputes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Open a dispute — automation pauses immediately',
    description:
      'Either party may open one, and opening is deliberately cheap and immediate: a party ' +
      'that believes something is wrong must be able to stop the machinery before it does ' +
      'something irreversible, without waiting for the platform to agree first. While the ' +
      'dispute is open the maturity job skips this transaction entirely — no reminders, no ' +
      'state changes (ZM-REC-013).',
  })
  @ApiResponse({ status: 201, description: 'Dispute opened; automation paused' })
  @ApiResponse({ status: 409, description: 'Already disputed, or not a disputable state' })
  async openDispute(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OpenDisputeDto,
  ): Promise<Record<string, unknown>> {
    return describeDispute(await this.disputes.open(id, contextOf(user, membership), body));
  }

  @Get('disputes/:id')
  @ApiOperation({ summary: 'A dispute — the same shared record for both parties' })
  @ApiResponse({ status: 200, description: 'Dispute' })
  async findDispute(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return describeDispute(await this.disputes.findById(id, contextOf(user, membership)));
  }

  @Post('disputes/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record the resolution the parties reached — the platform does not adjudicate',
    description:
      'ZM-REC-012/014. This stores what the parties agreed; it does not decide anything. ' +
      'There is no field for the platform’s view of who was right, and resolutionNotes is ' +
      'mandatory precisely so a dispute cannot be closed without someone stating what was ' +
      'decided. The transaction returns to the state it was in before the dispute — read ' +
      'from its own status history — and automation resumes.',
  })
  @ApiResponse({ status: 200, description: 'Resolution recorded; automation resumes' })
  async resolveDispute(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveDisputeDto,
  ): Promise<Record<string, unknown>> {
    return describeDispute(await this.disputes.resolve(id, contextOf(user, membership), body));
  }

  // -----------------------------------------------------------------
  // Withdrawal cases — ZM-WDR-*, AS-07, LT-12
  // -----------------------------------------------------------------

  @Post('offers/:id/withdrawal-case')
  @HttpCode(HttpStatus.CREATED)
  @RequireRoles('BANK_OPERATIONS', 'BANK_ADMIN')
  @ApiOperation({
    summary: 'Post-acceptance bank withdrawal',
    description:
      'A penalty is calculated from the configured policy and RECORDED — never deducted ' +
      '(LT-12). The platform holds no bank money to deduct from, has not adjudicated whether ' +
      'the withdrawal was justified, and two of the reasons describe a bank that was right to ' +
      'withdraw. Where the policy says null, the platform declines to guess and the case goes ' +
      'to an administrator with no suggested answer. Relisting is manual (D-03).',
  })
  @ApiResponse({ status: 201, description: 'Case opened; penalty recorded, not deducted' })
  @ApiResponse({ status: 409, description: 'An open case already exists for this offer' })
  async openWithdrawal(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OpenWithdrawalDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    return describeWithdrawal(await this.withdrawals.open(id, ctx, body), audienceOf(ctx));
  }

  @Get('withdrawal-cases/:id')
  @ApiOperation({ summary: 'A withdrawal case' })
  @ApiResponse({ status: 200, description: 'Withdrawal case' })
  async findWithdrawal(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    return describeWithdrawal(await this.withdrawals.findById(id, ctx), audienceOf(ctx));
  }

  @Post('withdrawal-cases/:id/decide')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN')
  @ApiOperation({
    summary: 'Admin decision — penalty applicability and amount, plus relisting eligibility',
    description:
      'Takes penaltyApplicable verbatim: the policy’s suggestion is a default to consider, ' +
      'never an answer that overrides a human who can see the commercial context. The penalty ' +
      'is still not deducted. An eligible relisting raises a REQUESTED relisting request, not ' +
      'an approved one — ZM-REC-018 requires seven verification outcomes before a receivable ' +
      'returns to the marketplace, and this decision does not certify any of them.',
  })
  @ApiResponse({ status: 200, description: 'Decided' })
  async decideWithdrawal(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideWithdrawalDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    return describeWithdrawal(await this.withdrawals.decide(id, ctx, body), audienceOf(ctx));
  }

  // -----------------------------------------------------------------
  // Fraud review — ZM-FRD-001..006
  // -----------------------------------------------------------------

  @Post('transactions/:id/fraud-review')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Open a fraud review — freezes the transaction, concludes nothing',
    description:
      'Freezing is immediate and reversible; labelling an organization is neither, so the ' +
      'cheap reversible action happens on suspicion and the expensive irreversible one waits ' +
      'for a compliance decision (ZM-FRD-004). Opening records suspicion, stops the money, and ' +
      'notifies compliance. It sets no verdict and restricts nobody.',
  })
  @ApiResponse({ status: 201, description: 'Frozen; compliance notified' })
  @ApiResponse({ status: 409, description: 'Already under review' })
  async openFraudReview(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OpenFraudReviewDto,
  ): Promise<Record<string, unknown>> {
    return describeFraudCase(await this.fraud.open(id, contextOf(user, membership), body));
  }

  @Get('fraud-cases/:id')
  @RequireRoles('PLATFORM_COMPLIANCE', 'PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN')
  @ApiOperation({
    summary: 'A fraud case — platform only',
    description:
      'Telling a supplier that a fraud review naming them exists, before compliance has ' +
      'concluded anything, turns an unproven suspicion into an accusation they must answer.',
  })
  @ApiResponse({ status: 200, description: 'Fraud case' })
  async findFraudCase(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return describeFraudCase(await this.fraud.findById(id, contextOf(user, membership)));
  }

  @Post('fraud-cases/:id/decide')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('PLATFORM_COMPLIANCE', 'PLATFORM_SUPER_ADMIN')
  @ApiOperation({
    summary: 'Compliance decision — the only thing that records a confirmed status',
    description:
      'ZM-FRD-004. Restricted to compliance: a bank that reported a suspicion must not also ' +
      'conclude its counterparty is fraudulent, and an operations admin should not be ' +
      'blacklisting businesses as a routine queue action. CLEARED returns the transaction to ' +
      'where it was and funding resumes; any other finding closes it, without deleting ' +
      'anything (INV-7).',
  })
  @ApiResponse({ status: 200, description: 'Decided; transaction unfrozen or closed' })
  @ApiResponse({ status: 403, description: 'Compliance only' })
  async decideFraudCase(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideFraudDto,
  ): Promise<Record<string, unknown>> {
    return describeFraudCase(await this.fraud.decide(id, contextOf(user, membership), body));
  }

  // -----------------------------------------------------------------
  // The unified case list
  // -----------------------------------------------------------------

  @Get('cases')
  @ApiOperation({
    summary: 'Role-scoped case list across fraud, disputes, withdrawal and recourse',
    description:
      'Platform sees all; a bank or supplier sees only cases on its own transactions. Fraud ' +
      'cases are excluded from a party’s list entirely rather than shown redacted — a ' +
      'supplier learning that a fraud case naming them exists IS the disclosure, and the ' +
      'fields are incidental. The summary carries a type, status, amount and date, and never ' +
      'a counterparty’s free text: a list view is exactly where such a field gets rendered ' +
      'without anyone thinking about who is reading it.',
  })
  @ApiQuery({ name: 'type', required: false, enum: ['FRAUD', 'DISPUTE', 'WITHDRAWAL', 'RECOURSE'] })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Case summaries with pagination' })
  async listCases(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query('type') type: CaseType | undefined,
    @Query('status') status: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
  ): Promise<Record<string, unknown>> {
    return this.caseList.list(contextOf(user, membership), {
      type,
      status,
      page: Math.max(1, page),
      pageSize: Math.min(100, Math.max(1, pageSize)),
    });
  }
}
