import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DemoService } from './demo.service';
import { TimeTravelDto } from './dto';
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

@ApiTags('Demo')
@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Post('time-travel')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN')
  @ApiOperation({
    summary: 'Advance the simulated clock — 404 unless the demo time machine is armed',
    description:
      'Moves the whole system clock by a whole number of days so maturity, overdue ' +
      'confirmation, deadlines and escalation can be demonstrated live. Guarded twice, both ' +
      'server-side: the DEMO_TIME_MACHINE_ENABLED env var (which the config refuses to set in ' +
      'production) AND the demo_time_machine_enabled platform setting. Either off returns 404 — ' +
      'the control is invisible, not merely forbidden. The offset is applied in one place, ' +
      'SystemTimeProvider.now(), and the provider is refreshed synchronously so the next ' +
      'request already sees the new clock.',
  })
  @ApiResponse({ status: 200, description: 'Clock advanced; scheduled jobs re-evaluated' })
  @ApiResponse({ status: 404, description: 'Not available in this environment' })
  async timeTravel(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: TimeTravelDto,
  ): Promise<Record<string, unknown>> {
    return this.demo.travel(body.offsetDays, contextOf(user, membership));
  }
}
