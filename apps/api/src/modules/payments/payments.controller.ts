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
import { PaymentsService } from './payments.service';
import { CloseTransactionDto, ConfirmStatusDto, RecordPaymentDto } from './dto';
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

@ApiTags('Payments')
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('transactions/:id/payments')
  @ApiOperation({
    summary: 'Payment history and the derived outstanding balance',
    description:
      'The balance is computed from the recorded payments on every read, never stored ' +
      '(D-13/PA-06) — `invoices.outstanding_amount` freezes at listing because it is what ' +
      'the offer was priced against. A supplier sees amounts, dates and references; it never ' +
      'sees `bankInternalNotes` or evidence document ids (ZM-PMT-018), which are built into ' +
      'a different payload rather than filtered out of a shared one.',
  })
  @ApiResponse({ status: 200, description: 'Payments, outstandingAmount, overdueDays' })
  @ApiResponse({ status: 404, description: 'Not a party to this transaction' })
  async list(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.payments.list(id, contextOf(user, membership));
  }

  @Post('transactions/:id/payments')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequireRoles('BANK_OPERATIONS', 'BANK_ADMIN')
  @ApiOperation({
    summary: 'Bank reports a buyer payment',
    description:
      'Moves the transaction to PARTIALLY_PAID or PAID according to the derived total, ' +
      'computed under a row lock so two simultaneous reports cannot both read the old ' +
      'balance. A bank reporting a payment is evidence; this is how a transaction becomes ' +
      'paid. Only the funding bank may report.',
  })
  @ApiResponse({ status: 201, description: 'Recorded, with the new outstanding balance' })
  @ApiResponse({ status: 409, description: 'Not in a state where a payment can be recorded' })
  async record(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordPaymentDto,
  ): Promise<Record<string, unknown>> {
    return this.payments.recordPayment(id, contextOf(user, membership), body);
  }

  @Post('transactions/:id/confirm-status')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('BANK_OPERATIONS', 'BANK_ADMIN')
  @ApiOperation({
    summary: 'Bank confirms the status of an OVERDUE_UNCONFIRMED transaction',
    description:
      'The only route to OVERDUE in the entire system. A due date passing produces ' +
      'OVERDUE_UNCONFIRMED and stops there, because the platform cannot see whether the ' +
      'buyer paid and absence of a report is never treated as proven default ' +
      '(ZM-PMT-008..011). PAID and PARTIALLY_PAID are equally valid confirmations — the ' +
      'common case is that the buyer did pay and nobody had recorded it. Confirming PAID ' +
      'while the recorded payments do not settle the invoice is refused, so the state and ' +
      'the money can never tell a supplier two different stories.',
  })
  @ApiResponse({ status: 200, description: 'Confirmed' })
  @ApiResponse({ status: 409, description: 'Nothing awaiting confirmation' })
  async confirmStatus(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConfirmStatusDto,
  ): Promise<Record<string, unknown>> {
    return this.payments.confirmStatus(id, contextOf(user, membership), body);
  }

  @Post('transactions/:id/close')
  @HttpCode(HttpStatus.OK)
  @RequireRoles(
    'BANK_OPERATIONS',
    'BANK_ADMIN',
    'PLATFORM_OPS_ADMIN',
    'PLATFORM_SUPER_ADMIN',
  )
  @ApiOperation({
    summary: 'Close a transaction with a reason',
    description:
      'Closure is a record, not a deletion (INV-7). Payments, cases, journals and ' +
      'notifications all stay exactly where they are; the transaction simply stops being ' +
      'live, with a reason naming why. Closing an already-closed transaction returns it ' +
      'unchanged rather than erroring.',
  })
  @ApiResponse({ status: 200, description: 'Closed' })
  async close(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CloseTransactionDto,
  ): Promise<Record<string, unknown>> {
    return this.payments.close(id, contextOf(user, membership), body);
  }
}
