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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { CreateCommissionTierDto } from './dto';
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

/**
 * The platform admin surface. Everything here is platform-only; the write
 * paths additionally require an admin role. RLS is the backstop.
 */
@ApiTags('Admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('settings')
  @RequireRoles('PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN', 'PLATFORM_SUPPORT')
  @ApiOperation({ summary: 'All platform settings as a key/value map' })
  @ApiResponse({ status: 200, description: 'Settings' })
  async getSettings(): Promise<Record<string, unknown>> {
    return this.admin.getSettings();
  }

  @Patch('settings')
  @RequireRoles('PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN')
  @ApiOperation({
    summary: 'Update platform settings by key',
    description:
      'The body is a free-form { key: value } map (the contract declares additionalProperties). ' +
      'Only keys that already exist may be written — a PATCH changes configuration, it does not ' +
      'invent it — and each changed key is audited with its old and new value, because a ' +
      'settings change moves system behaviour and must be attributable.',
  })
  @ApiResponse({ status: 200, description: 'Updated; the full settings map is returned' })
  async patchSettings(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.admin.patchSettings(body, contextOf(user, membership));
  }

  @Get('commission-tiers')
  @RequireRoles('PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN', 'PLATFORM_SUPPORT')
  @ApiOperation({ summary: 'Commission tiers, newest effective first' })
  @ApiResponse({ status: 200, description: 'Tiers' })
  async getCommissionTiers(): Promise<Record<string, unknown>[]> {
    return this.admin.getCommissionTiers();
  }

  @Post('commission-tiers')
  @HttpCode(HttpStatus.CREATED)
  @RequireRoles('PLATFORM_SUPER_ADMIN')
  @ApiOperation({
    summary: 'Create a commission tier — never edits an existing one',
    description:
      'Like the risk-model versions, this only creates, so a settled transaction’s commission ' +
      'can always be traced to the tier text that was in force. Money bounds go through the ' +
      'Money class and a malformed amount is rejected here, not at the database.',
  })
  @ApiResponse({ status: 201, description: 'Created' })
  async createCommissionTier(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: CreateCommissionTierDto,
  ): Promise<Record<string, unknown>> {
    return this.admin.createCommissionTier(body, contextOf(user, membership));
  }

  @Get('audit-logs')
  @RequireRoles('PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN', 'PLATFORM_SUPPORT')
  @ApiOperation({
    summary: 'The audit trail — every recorded mutation, newest first',
    description:
      'Platform-only and paginated. Optionally scoped to one entity via targetEntityId. This is ' +
      'where the before/after record every mutation has written since Phase 1 becomes readable ' +
      'by the people accountable for it.',
  })
  @ApiQuery({ name: 'targetEntityId', required: false })
  @ApiResponse({ status: 200, description: 'Audit entries with pagination' })
  async getAuditLogs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query('targetEntityId') targetEntityId?: string,
  ): Promise<Record<string, unknown>> {
    return this.admin.getAuditLogs({
      page: Math.max(1, page),
      pageSize: Math.min(100, Math.max(1, pageSize)),
      targetEntityId,
    });
  }

  @Post('relisting-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN')
  @ApiOperation({
    summary: 'Approve a relisting request the withdrawal flow raised (ZM-REC-018)',
    description:
      'Approvable only from REQUESTED or UNDER_REVIEW; anything else is a 409, and a second ' +
      'approve returns the request unchanged. See Q-18: the seven ZM-REC-018 verification ' +
      'outcomes have no recording surface in the contract, so this records the approval and the ' +
      'current verification state rather than enforcing seven checks that nothing can set.',
  })
  @ApiResponse({ status: 200, description: 'Approved' })
  @ApiResponse({ status: 409, description: 'Not in an approvable state' })
  async approveRelisting(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.admin.approveRelisting(id, contextOf(user, membership));
  }
}
