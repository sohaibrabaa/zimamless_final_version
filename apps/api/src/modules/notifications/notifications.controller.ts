import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { describeNotification, NotificationsService } from './notifications.service';
import { CurrentContext, CurrentUser, RequireRoles } from '../auth/decorators';
import { RecordManualCallDto } from './dto';
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

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'The signed-in user’s in-platform inbox',
    description:
      'Scoped to the caller by `recipient_user_id` and nothing else. A notification is ' +
      'addressed to a person rather than an organization, so there is no org filter and no ' +
      'way to read a colleague’s messages. `destination` and the gateway reference are not ' +
      'returned — an inbox is for reading messages, not auditing the transport, and the ' +
      'destination can carry a personal phone number.',
  })
  @ApiQuery({ name: 'unread', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Items, unreadCount, pagination' })
  async list(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query('unread', new DefaultValuePipe(false), ParseBoolPipe) unread: boolean,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
  ): Promise<Record<string, unknown>> {
    return this.notifications.list(contextOf(user, membership), {
      unread,
      page: Math.max(1, page),
      pageSize: Math.min(100, Math.max(1, pageSize)),
    });
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a notification read',
    description:
      'The one place DELIVERED is legitimately written. Handing a message to an email gateway ' +
      'is not the same as it reaching a person, so the gateways record SENT; a user opening an ' +
      'in-platform message is delivery the platform can actually observe. Idempotent — the ' +
      'first read stands, so re-rendering the inbox does not keep moving the timestamp.',
  })
  @ApiResponse({ status: 200, description: 'Marked read' })
  @ApiResponse({ status: 404, description: 'Not this user’s notification' })
  async markRead(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return describeNotification(
      await this.notifications.markRead(id, contextOf(user, membership)),
    );
  }

  @Post(':id/manual-call')
  @HttpCode(HttpStatus.OK)
  // Compliance is included deliberately: an officer telephoning a supplier
  // during a fraud review is exactly the call this record exists for, and
  // leaving it out would push that conversation into a case note where the
  // delivery evidence does not reach.
  @RequireRoles(
    'PLATFORM_OPS_ADMIN',
    'PLATFORM_SUPER_ADMIN',
    'PLATFORM_SUPPORT',
    'PLATFORM_COMPLIANCE',
  )
  @ApiOperation({
    summary: 'Record a call an operator actually made (ZM-NOT-007)',
    description:
      'Additive: the frozen contract and the v3.1.0 overlay both declare storage for the ' +
      'manual-call record and no way to write it (Q-17, ruled 2026-07-23). The platform cannot ' +
      'place calls, so this does not pretend to — it records that a human did, with their ' +
      'notes, through the same evidence fields as every other channel. Deliberately separate ' +
      'from `read`: a recipient opening their inbox and an operator attesting to a phone ' +
      'conversation are different claims by different people. The previous notes are kept in ' +
      'the audit entry, because the column holds one value and overwriting a colleague’s ' +
      'account of a conversation with no trace would be a hard delete of evidence (INV-7).',
  })
  @ApiResponse({ status: 200, description: 'Recorded' })
  @ApiResponse({ status: 404, description: 'No MANUAL_CALL notification with that id' })
  async recordManualCall(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordManualCallDto,
  ): Promise<Record<string, unknown>> {
    return describeNotification(
      await this.notifications.recordManualCall(id, contextOf(user, membership), body.notes),
    );
  }
}
