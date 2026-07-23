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
import { describeRecourse, RecourseService } from './recourse.service';
import { InitiateRecourseDto, RecourseStatusDto, RepayRecourseDto } from './dto';
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
  constructor(private readonly recourse: RecourseService) {}

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
}
