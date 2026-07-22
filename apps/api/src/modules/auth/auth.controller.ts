import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService, PlatformUser, MembershipRow } from './auth.service';
import { CurrentUser, OrgContextExempt } from './decorators';
import { AuthMeDto, MembershipDto, SetLanguageDto, SwitchContextDto } from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { TIME_PROVIDER, TimeProvider, SystemTimeProvider } from '../../common/time/time.provider';
import { ORGANIZATION_HEADER } from './auth.guard';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Auth and organization context.
 *
 * All three routes are @OrgContextExempt: they are how a client discovers
 * which organizations it may act for and chooses one. Requiring the header
 * to find out what the header may contain would be circular.
 */
@ApiTags('Auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  @Get('auth/me')
  @OrgContextExempt()
  @ApiOperation({ summary: 'Current user, memberships, and active context' })
  @ApiResponse({ status: 200, type: AuthMeDto })
  async me(
    @CurrentUser() user: PlatformUser,
    @Headers(ORGANIZATION_HEADER) organizationHeader?: string,
  ): Promise<AuthMeDto> {
    const memberships = await this.auth.listMemberships(user.id);

    // activeOrganizationId is echoed only when the header names an org the
    // user genuinely belongs to. Echoing it unchecked would let a client
    // believe it holds a context the guard will reject on the next call.
    const active = organizationHeader?.trim();
    const activeOrganizationId = memberships.some((m) => m.organization_id === active)
      ? active
      : undefined;

    const response: AuthMeDto = {
      user: toUserDto(user),
      memberships: memberships.map(toMembershipDto),
      ...(activeOrganizationId ? { activeOrganizationId } : {}),
    };

    // D-10: additive `demo` block, present only when the time machine is on.
    // Absent in production, which is what tells Agent B to hide the control.
    if (this.time instanceof SystemTimeProvider) await this.time.refreshIfStale();
    if (this.time.isTimeMachineEnabled()) {
      response.demo = {
        timeMachineEnabled: true,
        currentOffsetDays: this.time.currentOffsetDays(),
      };
    }

    return response;
  }

  @Post('auth/context')
  // The contract specifies 200, not the 201 NestJS returns for POST by
  // default. Nothing is created here — the context is re-checked from the
  // header on every request — so 201 would also be the wrong semantics.
  // Worth noting the path-level conformance gate cannot catch this: it
  // compares paths and verbs, and both sides agreed on POST /auth/context.
  @HttpCode(HttpStatus.OK)
  @OrgContextExempt()
  @Audit('AUTH_CONTEXT_SWITCHED', 'ORGANIZATION')
  @ApiOperation({ summary: 'Switch active organization context' })
  @ApiResponse({ status: 200, description: 'Context switched' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async switchContext(
    @CurrentUser() user: PlatformUser,
    @Body() body: SwitchContextDto,
  ): Promise<{ organizationId: string }> {
    // Throws 403 when the user has no ACTIVE membership there.
    //
    // The context is not server-side session state: the client sends
    // X-Organization-Id on every subsequent request and the guard re-checks
    // it each time. This endpoint validates the choice and — importantly —
    // produces the audit record of the switch, which the Phase 1 checkpoint
    // requires to be visible in audit_logs.
    const membership = await this.auth.resolveContext(user.id, body.organizationId);

    // Audit this against the organization being switched TO. The interceptor
    // reads actor org from the request context, which at this point still
    // holds the org the caller arrived with — recording that would file the
    // switch under the old context and make the trail read backwards.
    RequestContextStore.patch({
      organizationId: membership.organization_id,
      organizationType: membership.organization_type,
      roles: membership.roles,
    });

    return { organizationId: membership.organization_id };
  }

  @Patch('auth/language')
  @OrgContextExempt()
  @Audit('USER_LANGUAGE_CHANGED', 'USER')
  @ApiOperation({ summary: 'Set preferred language (persists per user)' })
  @ApiResponse({ status: 200, description: 'Updated' })
  async setLanguage(
    @CurrentUser() user: PlatformUser,
    @Body() body: SetLanguageDto,
  ): Promise<{ language: 'EN' | 'AR' }> {
    // ZM-I18N-003: an explicit choice, persisted per user. Never inferred
    // from Accept-Language or the browser locale.
    await this.auth.setPreferredLanguage(user.id, body.language);
    return { language: body.language };
  }
}

function toUserDto(user: PlatformUser) {
  // Built from an explicit field list. national_id_enc and national_id_last4
  // exist on the row and are deliberately absent here.
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    phoneNumber: user.phone_number,
    preferredLanguage: user.preferred_language,
    mfaEnabled: user.mfa_enabled,
    status: user.status,
  };
}

function toMembershipDto(m: MembershipRow): MembershipDto {
  return {
    organizationId: m.organization_id,
    organizationName: m.organization_name,
    organizationType: m.organization_type,
    roles: m.roles,
    isAuthorizedSignatory: m.is_authorized_signatory,
  };
}
