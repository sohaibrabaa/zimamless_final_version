import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ListingsService } from './listings.service';
import { OffersService } from './offers.service';
import { PolicyFiltersService } from './policy-filters.service';
import { TransactionsService } from '../transactions/transactions.service';
import { DatabaseService } from '../../database/database.service';
import {
  MarketplaceQueryDto,
  OfferInputDto,
  OfferListQueryDto,
  PolicyFilterDto,
  WithdrawOfferDto,
} from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { CurrentContext, CurrentUser, RequireRoles } from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { AppException } from '../../common/errors/app.exception';

/**
 * Marketplace, offers and policy filters.
 *
 * Route-level roles are the coarse gate; the services do the fine-grained
 * work, because "which bank" and "whose listing" are data questions that a
 * role decorator cannot answer. Both layers run — a bank analyst with the
 * right role still gets a 404 for another bank's offer.
 */

function contextOf(user: PlatformUser, membership: MembershipRow | undefined): ActorContext {
  if (!membership) throw AppException.organizationContextRequired();
  return {
    userId: user.id,
    organizationId: membership.organization_id,
    organizationType: membership.organization_type,
    roles: membership.roles,
  };
}

@ApiTags('Marketplace')
@Controller()
export class MarketplaceController {
  constructor(
    private readonly listings: ListingsService,
    private readonly offers: OffersService,
    private readonly policy: PolicyFiltersService,
    private readonly transactions: TransactionsService,
    private readonly db: DatabaseService,
  ) {}

  @Post('transactions/:id/listing')
  @RequireRoles('SUPPLIER_OWNER', 'SUPPLIER_SIGNATORY')
  @Audit('LISTING_ACTIVATED', 'LISTING')
  @ApiOperation({
    summary: 'Activate a marketplace listing',
    description:
      'Creates the listing-fee obligation immediately (ZM-FEE-002): the fee is incurred at ' +
      'activation whether or not financing later succeeds. Evaluates every active bank ' +
      'against its policy filters and records the rules applied (ZM-MKT-003).',
  })
  @ApiResponse({ status: 201, description: 'Listing activated' })
  @ApiResponse({ status: 409, description: 'Transaction is not ELIGIBLE, or already listed' })
  async activate(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const listing = await this.listings.activate(id, contextOf(user, membership));
    return this.listings.describe(listing, { offerCount: 0 });
  }

  @Get('transactions/:id/listing-current')
  @ApiOperation({ summary: 'Current-round listing for a transaction (D-06)' })
  @ApiResponse({ status: 200, description: 'Listing' })
  @ApiResponse({ status: 404, description: 'No listing exists for this transaction' })
  async currentListing(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    // Visibility comes from the transaction, so a bank that cannot see the
    // transaction cannot enumerate its listings either.
    const { audience } = await this.transactions.requireVisible(id, ctx);
    const listing = await this.listings.currentForTransaction(id);
    if (!listing) throw AppException.notFound('Listing');

    return this.listings.describe(
      listing,
      // offerCount is supplier/platform only (ZM-MKT-011).
      audience === 'BANK' ? {} : { offerCount: await this.offers.activeOfferCount(listing.id) },
    );
  }

  @Get('listings/:id')
  @ApiOperation({ summary: 'Listing detail' })
  @ApiResponse({ status: 200, description: 'Listing' })
  async listing(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const listing = await this.listings.findById(id);
    if (!listing) throw AppException.notFound('Listing');

    const { audience } = await this.transactions.requireVisible(listing.transaction_id, ctx);
    return this.listings.describe(
      listing,
      audience === 'BANK' ? {} : { offerCount: await this.offers.activeOfferCount(listing.id) },
    );
  }

  @Get('listings/:id/offers')
  @ApiOperation({
    summary: 'Offers on a listing, scoped by role',
    description:
      'Supplier: all ACTIVE offers, fully. Bank: its OWN offer only — never another bank’s ' +
      'data and never the count of competitors (INV-11).',
  })
  @ApiResponse({ status: 200, description: 'Offers' })
  async listingOffers(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>[]> {
    const ctx = contextOf(user, membership);
    const rows = await this.offers.listForListing(id, ctx);
    const audience = ctx.organizationType === 'BANK'
      ? 'OWNING_BANK'
      : ctx.organizationType === 'PLATFORM'
        ? 'PLATFORM'
        : 'SUPPLIER';
    return Promise.all(rows.map((row) => this.offers.describe(row, audience)));
  }

  @Get('marketplace/eligible')
  @RequireRoles('BANK_ADMIN', 'BANK_ANALYST', 'BANK_OFFER_MAKER', 'BANK_OFFER_APPROVER')
  @ApiOperation({ summary: 'Listings this bank is eligible for' })
  @ApiResponse({ status: 200, description: 'Page of bank listing views' })
  async eligible(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query() query: MarketplaceQueryDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const offset = (query.page - 1) * query.pageSize;

    // Only OPEN_FOR_OFFERS listings this bank was found eligible for. The
    // join is the filter — there is no post-fetch discard that a later edit
    // could remove.
    const countRow = await this.db.queryOne<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM listings l
         JOIN bank_eligibility e ON e.listing_id = l.id
        WHERE e.bank_org_id = $1 AND e.status = 'ELIGIBLE' AND l.status = 'OPEN_FOR_OFFERS'`,
      [ctx.organizationId],
    );
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT l.id
         FROM listings l
         JOIN bank_eligibility e ON e.listing_id = l.id
        WHERE e.bank_org_id = $1 AND e.status = 'ELIGIBLE' AND l.status = 'OPEN_FOR_OFFERS'
        ORDER BY l.offer_submission_deadline
        LIMIT ${query.pageSize} OFFSET ${offset}`,
      [ctx.organizationId],
    );

    const items = [];
    for (const { id } of rows) {
      const listing = await this.listings.findById(id);
      if (listing) items.push(await this.offers.describeForBank(listing, ctx));
    }

    const total = Number(countRow?.n ?? 0);
    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  @Get('marketplace/listings/:id')
  @RequireRoles('BANK_ADMIN', 'BANK_ANALYST', 'BANK_OFFER_MAKER', 'BANK_OFFER_APPROVER')
  @ApiOperation({
    summary: 'One listing in the bank’s view (D-07)',
    description:
      'Same confidentiality exclusions as the feed: no supplier floor, no offer count, ' +
      'no competitor data.',
  })
  @ApiResponse({ status: 200, description: 'Bank listing view' })
  @ApiResponse({ status: 403, description: 'Bank not eligible for this listing' })
  async underwritingView(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const listing = await this.listings.findById(id);
    if (!listing) throw AppException.notFound('Listing');

    const eligibility = await this.db.queryOne<{ status: string }>(
      `SELECT status FROM bank_eligibility WHERE listing_id = $1 AND bank_org_id = $2`,
      [id, ctx.organizationId],
    );
    if (!eligibility || eligibility.status !== 'ELIGIBLE') {
      // The overlay declares 403 here, so this is the one place a
      // not-eligible bank is told the listing exists. That is the contract's
      // choice and it is defensible: the bank was evaluated against its own
      // filters and is entitled to know it was excluded rather than that
      // nothing is there.
      throw AppException.insufficientRole(['marketplace eligibility for this listing']);
    }
    return this.offers.describeForBank(listing, ctx);
  }

  // -------------------------------------------------------------------
  // Policy filters
  // -------------------------------------------------------------------

  @Get('banks/policy-filters')
  @RequireRoles('BANK_ADMIN', 'BANK_ANALYST', 'BANK_OFFER_MAKER', 'BANK_OFFER_APPROVER')
  @ApiOperation({ summary: 'This bank’s policy filters' })
  @ApiResponse({ status: 200, description: 'Policy filters' })
  async policyFilters(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query() _unused: MarketplaceQueryDto,
  ): Promise<Record<string, unknown>[]> {
    const filters = await this.policy.listForBank(contextOf(user, membership));
    return filters.map((f) => this.policy.describe(f));
  }

  @Post('banks/policy-filters')
  @RequireRoles('BANK_ADMIN')
  @Audit('POLICY_FILTER_CREATED', 'BANK_POLICY_FILTER')
  @ApiOperation({ summary: 'Create a policy filter' })
  @ApiResponse({ status: 201, description: 'Created' })
  async createPolicyFilter(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: PolicyFilterDto,
  ): Promise<Record<string, unknown>> {
    const row = await this.policy.create(contextOf(user, membership), body);
    return this.policy.describe(row);
  }

  @Patch('banks/policy-filters/:id')
  @RequireRoles('BANK_ADMIN')
  @Audit('POLICY_FILTER_UPDATED', 'BANK_POLICY_FILTER')
  @ApiOperation({
    summary: 'Update or deactivate a policy filter (D-12)',
    description:
      'Deactivation is a flag, never a delete: eligibility decisions cite the filter that ' +
      'made them, and deleting it would orphan the rules_applied trace.',
  })
  @ApiResponse({ status: 200, description: 'Updated' })
  async updatePolicyFilter(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PolicyFilterDto,
  ): Promise<Record<string, unknown>> {
    const row = await this.policy.update(id, contextOf(user, membership), body);
    return this.policy.describe(row);
  }
}

@ApiTags('Offers')
@Controller()
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Post('listings/:id/offers/create')
  @RequireRoles('BANK_OFFER_MAKER', 'BANK_ADMIN')
  @Audit('OFFER_CREATED', 'BANK_OFFER')
  @ApiOperation({
    summary: 'Create a draft offer (BANK_OFFER_MAKER)',
    description:
      'The server recomputes netSupplierPayout and injects the platform commission and ' +
      'listing fee. A net below the supplier’s private floor is refused with ' +
      'OFFER_BELOW_SUPPLIER_REQUIREMENT and no numeric detail whatsoever (ZM-MKT-012).',
  })
  @ApiResponse({ status: 201, description: 'Offer created, awaiting internal approval' })
  @ApiResponse({ status: 422, description: 'Generic refusal — no floor, gap or percentage' })
  async create(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OfferInputDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const offer = await this.offers.create(id, ctx, body);
    return this.offers.describe(offer, 'OWNING_BANK');
  }

  @Get('offers')
  @RequireRoles('BANK_ADMIN', 'BANK_ANALYST', 'BANK_OFFER_MAKER', 'BANK_OFFER_APPROVER')
  @ApiOperation({
    summary: 'Offers of the active bank organization (D-08)',
    description: 'Approval queue and "my offers". Scoped strictly to the active bank org.',
  })
  @ApiResponse({ status: 200, description: 'Page of offers' })
  async list(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Query() query: OfferListQueryDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const { items, total } = await this.offers.listForBank(ctx, query);
    return {
      items: await Promise.all(items.map((row) => this.offers.describe(row, 'OWNING_BANK'))),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  @Get('offers/:id')
  @ApiOperation({ summary: 'Offer detail' })
  @ApiResponse({ status: 200, description: 'Offer' })
  async detail(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const { offer, audience } = await this.offers.requireVisible(id, ctx);
    return this.offers.describe(offer, audience);
  }

  @Patch('offers/:id')
  @RequireRoles('BANK_OFFER_MAKER', 'BANK_ADMIN')
  @Audit('OFFER_REVISED', 'BANK_OFFER')
  @ApiOperation({
    summary: 'Revise an offer (creates a new version)',
    description: 'The superseded version moves to REVISED and its lineage is kept.',
  })
  @ApiResponse({ status: 200, description: 'Revised' })
  async revise(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OfferInputDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const offer = await this.offers.revise(id, ctx, body);
    return this.offers.describe(offer, 'OWNING_BANK');
  }

  @Post('offers/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('BANK_OFFER_APPROVER', 'BANK_ADMIN')
  @Audit('OFFER_APPROVED', 'BANK_OFFER')
  @ApiOperation({
    summary: 'Internal approval (BANK_OFFER_APPROVER)',
    description: 'Rejected if the approver is the user who created the offer (INV-12).',
  })
  @ApiResponse({ status: 200, description: 'Approved and published as ACTIVE' })
  @ApiResponse({ status: 403, description: 'Self-approval prohibited (SELF_APPROVAL_FORBIDDEN)' })
  async approve(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const offer = await this.offers.approve(id, ctx);
    return this.offers.describe(offer, 'OWNING_BANK');
  }

  @Post('offers/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('BANK_OFFER_MAKER', 'BANK_OFFER_APPROVER', 'BANK_ADMIN')
  @Audit('OFFER_WITHDRAWN', 'BANK_OFFER')
  @ApiOperation({ summary: 'Withdraw before acceptance (no penalty)' })
  @ApiResponse({ status: 200, description: 'Withdrawn' })
  @ApiResponse({ status: 409, description: 'Already accepted — use the withdrawal-case endpoint' })
  async withdraw(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WithdrawOfferDto,
  ): Promise<Record<string, unknown>> {
    const ctx = contextOf(user, membership);
    const offer = await this.offers.withdraw(id, ctx, body.reason);
    return this.offers.describe(offer, 'OWNING_BANK');
  }
}
