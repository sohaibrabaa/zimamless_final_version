import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OnboardingService, ActorContext } from './onboarding.service';
import {
  BankAccountDto,
  ConsentsDto,
  CreateApplicationDto,
  DecideDto,
  ListQueryDto,
  RegisterDto,
  RegisterResponseDto,
  RespondDto,
} from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import {
  BootstrapsOrganization,
  CurrentContext,
  CurrentUser,
  OrgContextExempt,
  RequireRoles,
} from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';
import { RequestContextStore } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';

/**
 * Supplier onboarding (requirements §5, contract /onboarding/*).
 *
 * Path shapes come from the frozen contract and the v3.1.0 overlay exactly,
 * including the two suffixed overlay paths — `/onboarding/applications-list`
 * is not a nicer spelling of `/onboarding/applications`, it is the path
 * D-05 ruled, and the conformance gate compares it literally.
 */
@ApiTags('Onboarding')
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  private contextOf(user: PlatformUser, membership: MembershipRow | undefined): ActorContext {
    if (!membership) throw AppException.organizationContextRequired();
    return {
      userId: user.id,
      organizationId: membership.organization_id,
      organizationType: membership.organization_type,
      roles: membership.roles,
    };
  }

  // ------------------------------------------------------------------
  // D-04 bootstrap
  // ------------------------------------------------------------------

  @Post('onboarding/register')
  @OrgContextExempt()
  @BootstrapsOrganization()
  @Audit('SUPPLIER_ORGANIZATION_REGISTERED', 'ORGANIZATION')
  @ApiOperation({ summary: 'Bootstrap a supplier organization, membership, and draft application' })
  @ApiResponse({ status: 201, type: RegisterResponseDto })
  @ApiResponse({ status: 200, description: 'Already bootstrapped — returns the existing ids' })
  @ApiResponse({ status: 409, description: 'Establishment number already registered' })
  async register(
    @CurrentUser() user: PlatformUser,
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterResponseDto> {
    const result = await this.onboarding.register(user.id, body);

    // Hard rule 6: this mutation had no organization context on the way in
    // — there was no organization yet. Now there is, so the audit row names
    // it. Same pattern as /auth/context recording the org switched TO.
    RequestContextStore.patch({
      organizationId: result.organizationId,
      organizationType: 'SUPPLIER',
      roles: ['SUPPLIER_OWNER'],
    });

    // The overlay declares 201 for a fresh bootstrap and 200 when one
    // already existed. Idempotency the caller can actually observe.
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);

    return { organizationId: result.organizationId, applicationId: result.applicationId };
  }

  // ------------------------------------------------------------------
  // D-05 list
  // ------------------------------------------------------------------

  @Get('onboarding/applications-list')
  @ApiOperation({ summary: 'List applications — own for a supplier, the queue for a reviewer' })
  @ApiResponse({ status: 200, description: 'Applications page' })
  async list(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query() query: ListQueryDto,
  ): Promise<Record<string, unknown>> {
    return this.onboarding.list(this.contextOf(user, membership), {
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  // ------------------------------------------------------------------
  // Applications
  // ------------------------------------------------------------------

  @Post('onboarding/applications')
  @Audit('SUPPLIER_APPLICATION_CREATED', 'SUPPLIER_APPLICATION')
  @ApiOperation({ summary: 'Start a supplier application' })
  @ApiResponse({ status: 201, description: 'Application created' })
  async create(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: CreateApplicationDto,
  ): Promise<Record<string, unknown>> {
    const ctx = this.contextOf(user, membership);
    // The organization already exists here (unlike /register), so this is
    // the "start another application" path rather than the bootstrap one.
    const result = await this.onboarding.register(ctx.userId, body);
    const row = await this.onboarding.getApplicationRow(result.applicationId);
    if (!row) throw AppException.notFound('Application');
    return this.onboarding.describe(row);
  }

  @Get('onboarding/applications/:id')
  @ApiOperation({ summary: 'Application detail, including SLA state and government data' })
  @ApiResponse({ status: 200, description: 'Application' })
  async detail(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = this.contextOf(user, membership);
    const row = await this.onboarding.requireVisibleApplication(id, ctx);
    return this.onboarding.describe(row);
  }

  @Post('onboarding/applications/:id/submit')
  // The contract declares 200 for submit, not the 201 NestJS defaults to for
  // POST. The conformance gate now compares status codes, so this is
  // checked rather than trusted.
  @HttpCode(HttpStatus.OK)
  @Audit('SUPPLIER_APPLICATION_SUBMITTED', 'SUPPLIER_APPLICATION')
  @ApiOperation({ summary: 'Submit for review — starts the 24 business-hour SLA clock' })
  @ApiResponse({ status: 200, description: 'Submitted' })
  async submit(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.onboarding.submit(id, this.contextOf(user, membership));
  }

  @Post('onboarding/applications/:id/bank-account')
  @Audit('SUPPLIER_BANK_ACCOUNT_ADDED', 'SUPPLIER_BANK_ACCOUNT')
  @ApiOperation({ summary: 'Attach the payout bank account' })
  @ApiResponse({ status: 201, description: 'Created' })
  async bankAccount(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BankAccountDto,
  ): Promise<void> {
    await this.onboarding.addBankAccount(id, this.contextOf(user, membership), body);
  }

  @Post('onboarding/applications/:id/consents')
  @Audit('SUPPLIER_CONSENTS_RECORDED', 'CONSENT_RECORD')
  @ApiOperation({ summary: 'Record consent decisions' })
  @ApiResponse({ status: 201, description: 'Recorded' })
  async consents(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConsentsDto,
  ): Promise<void> {
    await this.onboarding.recordConsents(id, this.contextOf(user, membership), body.consents);
  }

  @Get('onboarding/applications/:id/information-requests')
  @ApiOperation({ summary: 'Outstanding and historical information requests' })
  @ApiResponse({ status: 200, description: 'Information requests' })
  async informationRequests(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>[]> {
    return this.onboarding.listInformationRequests(id, this.contextOf(user, membership));
  }

  @Post('onboarding/applications/:id/respond')
  @HttpCode(HttpStatus.OK)
  @Audit('SUPPLIER_INFORMATION_PROVIDED', 'INFORMATION_REQUEST')
  @ApiOperation({ summary: 'Respond to an information request — resumes the SLA clock' })
  @ApiResponse({ status: 200, description: 'Recorded' })
  async respond(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RespondDto,
  ): Promise<void> {
    await this.onboarding.respond(id, this.contextOf(user, membership), body);
  }

  @Post('onboarding/applications/:id/decide')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('PLATFORM_SUPPLIER_REVIEWER', 'PLATFORM_SUPER_ADMIN', 'PLATFORM_OPS_ADMIN')
  @Audit('SUPPLIER_APPLICATION_DECIDED', 'SUPPLIER_APPLICATION')
  @ApiOperation({ summary: 'Reviewer decision (PLATFORM_SUPPLIER_REVIEWER)' })
  @ApiResponse({ status: 200, description: 'Decided' })
  async decide(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideDto,
  ): Promise<Record<string, unknown>> {
    return this.onboarding.decide(id, this.contextOf(user, membership), body);
  }
}
