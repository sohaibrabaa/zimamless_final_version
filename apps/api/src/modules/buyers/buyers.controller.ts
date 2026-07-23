import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BuyersService } from './buyers.service';
import { BuyerSearchQueryDto, ResolveBuyerDto } from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { CurrentContext, CurrentUser } from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { AppException } from '../../common/errors/app.exception';

/**
 * Buyers (contract /buyers/*).
 *
 * `/buyers/search` returns candidates and never a selection; `/buyers/resolve`
 * is the only route that links a buyer to a supplier, and it requires the
 * supplier's explicit confirmation (ZM-BUY-009).
 */
@ApiTags('Buyers')
@Controller()
export class BuyersController {
  constructor(private readonly buyers: BuyersService) {}

  private contextOf(user: PlatformUser, membership: MembershipRow | undefined): ActorContext {
    if (!membership) throw AppException.organizationContextRequired();
    return {
      userId: user.id,
      organizationId: membership.organization_id,
      organizationType: membership.organization_type,
      roles: membership.roles,
    };
  }

  @Get('buyers/search')
  @ApiOperation({
    summary: 'Search own buyers, then platform buyers, then the registry',
    description:
      'Returns candidates only. The platform never auto-selects on name similarity (ZM-BUY-009).',
  })
  @ApiResponse({ status: 200, description: 'Candidates and the manual-review flag' })
  async search(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query() query: BuyerSearchQueryDto,
  ): Promise<Record<string, unknown>> {
    return this.buyers.search(this.contextOf(user, membership), query.q);
  }

  @Post('buyers/resolve')
  // The contract declares 200 for resolve, not the 201 NestJS defaults to
  // for POST. The conformance gate compares status codes, so this is
  // checked rather than assumed.
  @HttpCode(HttpStatus.OK)
  @Audit('BUYER_RESOLVED', 'BUYER')
  @ApiOperation({ summary: 'Confirm a buyer selection and create or link the global record' })
  @ApiResponse({ status: 200, description: 'Buyer resolved and linked' })
  @ApiResponse({ status: 409, description: 'Buyer blocked (SUSPENDED / STRUCK_OFF)' })
  async resolve(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: ResolveBuyerDto,
  ): Promise<Record<string, unknown>> {
    return this.buyers.resolve(this.contextOf(user, membership), body);
  }

  @Get('buyers/:id')
  @ApiOperation({ summary: 'Buyer detail' })
  @ApiResponse({ status: 200, description: 'Buyer' })
  async detail(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.buyers.getForCaller(id, this.contextOf(user, membership));
  }
}
