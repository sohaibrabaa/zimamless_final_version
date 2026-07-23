import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RiskService } from './risk.service';
import { RiskModelsService } from './risk-models.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreateRiskModelDto } from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { CurrentContext, CurrentUser, RequireRoles } from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { AppException } from '../../common/errors/app.exception';

/**
 * Trust Score endpoints (contract `/transactions/{id}/risk`,
 * `/admin/risk-models`).
 *
 * Visibility is delegated to `TransactionsService.requireVisible`, which is
 * the same gate the transaction detail uses — so a bank that cannot see a
 * transaction cannot see its score either, and the two can never disagree
 * about who is allowed to look. It 404s rather than 403s, for the same
 * no-enumeration-oracle reason as everywhere else.
 */
@ApiTags('Transactions')
@Controller()
export class RiskController {
  constructor(
    private readonly risk: RiskService,
    private readonly models: RiskModelsService,
    private readonly transactions: TransactionsService,
  ) {}

  private contextOf(user: PlatformUser, membership: MembershipRow | undefined): ActorContext {
    if (!membership) throw AppException.organizationContextRequired();
    return {
      userId: user.id,
      organizationId: membership.organization_id,
      organizationType: membership.organization_type,
      roles: membership.roles,
    };
  }

  @Get('transactions/:id/risk')
  @ApiOperation({
    summary: 'Trust Score and component indicators',
    description:
      'dataAvailabilityPct is reported separately from the score: government downtime ' +
      'reduces it and never the score itself (ZM-RSK-005/006). Banks receive scores and ' +
      'factors but never weights or model internals (ZM-RSK-013).',
  })
  @ApiResponse({ status: 200, description: 'Risk assessment' })
  async assessment(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = this.contextOf(user, membership);
    // Visibility first, and by the same gate the transaction detail uses —
    // a caller who cannot see the transaction must not learn its score exists.
    const { audience } = await this.transactions.requireVisible(id, ctx);

    const assessment = await this.risk.latest(id);
    const model = await this.models.findById(assessment.model_version_id);

    return this.risk.describe(
      assessment,
      { versionLabel: model?.version_label ?? 'unknown' },
      audience,
      user.preferred_language,
    );
  }
}

/**
 * Administrative model-version management.
 *
 * There is no PUT and no PATCH here, and that absence is the requirement:
 * ZM-RSK-009 says a change creates a new version rather than editing one.
 * A route that could edit an active version is the whole defect.
 */
@ApiTags('Admin')
@Controller()
export class AdminRiskModelsController {
  constructor(private readonly models: RiskModelsService) {}

  @Get('admin/risk-models')
  @RequireRoles('PLATFORM_SUPER_ADMIN', 'PLATFORM_OPS_ADMIN', 'PLATFORM_AUDITOR')
  @ApiOperation({ summary: 'All risk model versions, newest first' })
  @ApiResponse({ status: 200, description: 'Risk model versions' })
  async list(): Promise<Record<string, unknown>[]> {
    return (await this.models.list()).map((row) => this.models.describe(row));
  }

  @Post('admin/risk-models')
  @RequireRoles('PLATFORM_SUPER_ADMIN', 'PLATFORM_OPS_ADMIN')
  @Audit('RISK_MODEL_VERSION_CREATED', 'RISK_MODEL_VERSION')
  @ApiOperation({
    summary: 'Create a new scoring version (never edits an active one)',
    description:
      'Activating requires a rationale, which is recorded with the actor and timestamp ' +
      '(ZM-RSK-011). Existing assessments keep the version they were calculated with.',
  })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 409, description: 'That version label already exists' })
  async create(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: CreateRiskModelDto,
  ): Promise<Record<string, unknown>> {
    if (!membership) throw AppException.organizationContextRequired();
    const row = await this.models.create(body, {
      userId: user.id,
      organizationId: membership.organization_id,
      organizationType: membership.organization_type,
      roles: membership.roles,
    });
    return this.models.describe(row);
  }
}
