import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GovernmentService, SubjectType } from './government.service';
import { GovSource } from './government-adapter';
import { GovernmentLookupDto } from '../onboarding/dto';
import { OnboardingService, ActorContext } from '../onboarding/onboarding.service';
import { Audit } from '../../common/audit/audit.interceptor';
import { AppException } from '../../common/errors/app.exception';
import { CurrentContext, CurrentUser } from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';

/**
 * Government verification (contract /government/*).
 *
 * `sourceAvailable` is on every response and is the field consumers must
 * branch on. A client that renders "not found" for an unavailable source
 * has reintroduced the exact confusion hard rule 7 forbids — so the field
 * is always present, never optional, and never inferred from `status`
 * alone by the caller.
 *
 * Access model: platform staff see everything; anyone else may look up and
 * read ONLY their own organization's establishment number. A registry
 * snapshot is a company's full record — before this gate existed, any
 * authenticated user could read any company's data by request id.
 */
const PLATFORM_ROLES = ['PLATFORM_SUPPLIER_REVIEWER', 'PLATFORM_SUPER_ADMIN', 'PLATFORM_OPS_ADMIN'];

/** The sources with a registered adapter. EINVOICE is contract-legal but has no adapter until its phase. */
const SUPPORTED_SOURCES: ReadonlySet<string> = new Set(['CCD', 'ISTD', 'GAM']);

@ApiTags('Government')
@Controller()
export class GovernmentController {
  constructor(
    private readonly government: GovernmentService,
    private readonly onboarding: OnboardingService,
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

  private isPlatform(ctx: ActorContext): boolean {
    return ctx.roles.some((role) => PLATFORM_ROLES.includes(role));
  }

  /** The caller's own establishment number — the only key a non-platform user may query. */
  private async ownEstablishmentNumber(ctx: ActorContext): Promise<string | null> {
    const row = await this.government.establishmentNumberOf(ctx.organizationId);
    return row;
  }

  @Post('government/lookup')
  // The contract declares 202 Accepted: a real registry call is
  // asynchronous. The dummy adapters answer inline, but the status code is
  // the contract's and the response is the request resource either way, so
  // the client polls identically against a live integration later.
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('GOVERNMENT_LOOKUP_REQUESTED', 'GOVERNMENT_VERIFICATION_REQUEST')
  @ApiOperation({ summary: 'Trigger a registry lookup via adapter' })
  @ApiResponse({ status: 202, description: 'Accepted — poll the request for result' })
  async lookup(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: GovernmentLookupDto,
  ): Promise<Record<string, unknown>> {
    const ctx = this.contextOf(user, membership);

    // EINVOICE is in the contract's enum but no adapter exists yet —
    // refuse it by name rather than letting adapter resolution throw.
    if (!SUPPORTED_SOURCES.has(body.source)) {
      throw AppException.validation(
        `Source ${body.source} is not available yet. Supported sources: ${[...SUPPORTED_SOURCES].join(', ')}.`,
        { field: 'source' },
      );
    }

    // A non-platform caller may query only their own establishment number.
    // Letting any org member look up arbitrary numbers would hand them any
    // company's full registry record inline.
    if (!this.isPlatform(ctx)) {
      const own = await this.ownEstablishmentNumber(ctx);
      if (!own || body.lookupKey.trim() !== own) {
        throw AppException.notFound('Government request');
      }
    }

    const { request } = await this.government.lookup({
      source: body.source as GovSource,
      lookupKey: body.lookupKey,
      subjectType: (body.subjectType ?? 'ORGANIZATION') as SubjectType,
      subjectId: body.subjectId ?? null,
    });

    // The contract-legal outage recovery (Q-08's sibling): a successful
    // lookup for an application paused on GOVERNMENT_SERVICE_UNAVAILABLE
    // re-runs automated verification, which resumes the clock — or
    // re-pauses if the source is still down. No new endpoint invented.
    await this.onboarding.resumeIfWaiting(body.lookupKey, ctx);

    return this.present(request);
  }

  @Get('government/requests/:id')
  @ApiOperation({ summary: 'Poll a government verification request' })
  @ApiResponse({ status: 200, description: 'Government request' })
  async request(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = this.contextOf(user, membership);
    const request = await this.government.getRequest(id);
    if (!request) throw AppException.notFound('Government request');

    // Same enumeration-oracle stance as applications: a request that is not
    // yours is indistinguishable from one that does not exist. Ownership is
    // by lookup key ↔ the caller's own establishment number, since requests
    // may pre-date the subject organization row.
    if (!this.isPlatform(ctx)) {
      const own = await this.ownEstablishmentNumber(ctx);
      const owns =
        (own !== null && request.lookup_key === own) ||
        (request.subject_type === 'ORGANIZATION' && request.subject_id === ctx.organizationId);
      if (!owns) throw AppException.notFound('Government request');
    }

    return this.present(request);
  }

  private async present(request: {
    id: string;
    source: string;
    status: string;
    source_available: boolean;
    responded_at: Date | null;
  }): Promise<Record<string, unknown>> {
    const snapshot = await this.government.snapshotOf(request.id);
    return {
      id: request.id,
      source: request.source,
      status: request.status,
      // Never derived by the caller. See the class comment.
      sourceAvailable: request.source_available,
      normalizedData: snapshot?.normalized_payload ?? null,
      retrievedAt: snapshot?.retrieved_at?.toISOString() ?? request.responded_at?.toISOString() ?? null,
      validUntil: snapshot?.valid_until?.toISOString() ?? null,
    };
  }
}
