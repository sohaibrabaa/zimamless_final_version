import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  Matches,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MONEY_MESSAGE, MONEY_PATTERN } from '../../common/money/money';

/**
 * Marketplace and offer DTOs.
 *
 * Note what `OfferInputDto` does NOT declare: `platformCommissionAmount` and
 * `listingFeeAmount`. The contract is explicit that both are computed
 * server-side, and the global `ValidationPipe` runs with
 * `forbidNonWhitelisted: true` — so a bank that sends them gets a 400 naming
 * the offending property rather than having them silently ignored. That is
 * the friendlier failure: a bank whose integration computes its own
 * commission has a misunderstanding worth surfacing, not papering over.
 *
 * `netSupplierPayout` IS accepted, and is checked against the server's own
 * figure rather than trusted. Accepting it is what lets the server tell a
 * bank "your arithmetic and mine disagree" instead of quietly substituting a
 * different number into an offer the bank thinks it understands.
 */

export const TRANSACTION_TYPES = [
  'INVOICE_FINANCING',
  'RECEIVABLE_PURCHASE',
  'RECEIVABLE_ASSIGNMENT',
  'OTHER',
] as const;

export const RECOURSE_TYPES = [
  'FULL_RECOURSE',
  'LIMITED_RECOURSE',
  'NON_RECOURSE',
  'OTHER',
] as const;

export const CONDITION_TYPES = [
  'REQUIRED_GUARANTEE',
  'REQUIRED_DOCUMENT',
  'RECOURSE_TERM',
  'FUNDING_TIMELINE',
  'CONTRACTUAL_CONDITION',
  'OTHER',
] as const;

export const RISK_BANDS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export class OfferConditionDto {
  @ApiProperty({ enum: CONDITION_TYPES })
  @IsIn(CONDITION_TYPES as unknown as string[])
  conditionType!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;
}

export class OfferInputDto {
  @ApiProperty({ enum: TRANSACTION_TYPES })
  @IsIn(TRANSACTION_TYPES as unknown as string[])
  transactionType!: string;

  @ApiProperty({ enum: RECOURSE_TYPES })
  @IsIn(RECOURSE_TYPES as unknown as string[])
  recourseType!: string;

  @ApiProperty({ example: '10000.000', description: '3-decimal string, never a number.' })
  @Matches(MONEY_PATTERN, { message: `grossFundingAmount ${MONEY_MESSAGE}` })
  grossFundingAmount!: string;

  @ApiPropertyOptional({ example: '300.000' })
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: `bankDiscountAmount ${MONEY_MESSAGE}` })
  bankDiscountAmount?: string;

  @ApiPropertyOptional({ example: '150.000' })
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: `bankFeesAmount ${MONEY_MESSAGE}` })
  bankFeesAmount?: string;

  @ApiPropertyOptional({ example: '0.000' })
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: `otherDeductionsAmount ${MONEY_MESSAGE}` })
  otherDeductionsAmount?: string;

  @ApiPropertyOptional({
    description:
      'Optional. If supplied it must equal the server calculation exactly; ' +
      'a mismatch is rejected rather than silently corrected.',
  })
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: `netSupplierPayout ${MONEY_MESSAGE}` })
  netSupplierPayout?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString()
  expectedPayoutDate?: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601()
  validUntil!: string;

  @ApiPropertyOptional({ type: [OfferConditionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OfferConditionDto)
  conditions?: OfferConditionDto[];
}

export class WithdrawOfferDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

export class PolicyFilterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: '1000.000' })
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: `minAmount ${MONEY_MESSAGE}` })
  minAmount?: string;

  @ApiPropertyOptional({ example: '500000.000' })
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: `maxAmount ${MONEY_MESSAGE}` })
  maxAmount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  minTenorDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxTenorDays?: number;

  @ApiPropertyOptional({ enum: TRANSACTION_TYPES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(TRANSACTION_TYPES as unknown as string[], { each: true })
  acceptedTransactionTypes?: string[];

  @ApiPropertyOptional({ enum: RECOURSE_TYPES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(RECOURSE_TYPES as unknown as string[], { each: true })
  acceptedRecourseTypes?: string[];

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minTrustScore?: number;

  @ApiPropertyOptional({ enum: RISK_BANDS })
  @IsOptional()
  @IsIn(RISK_BANDS as unknown as string[])
  maxRiskBand?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sectorsInclude?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sectorsExclude?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  governoratesInclude?: string[];

  @ApiPropertyOptional({ enum: TRANSACTION_TYPES })
  @IsOptional()
  @IsIn(TRANSACTION_TYPES as unknown as string[])
  defaultTransactionType?: string;
}

export class OfferListQueryDto {
  @ApiPropertyOptional({ example: 'PENDING_INTERNAL_APPROVAL' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export class MarketplaceQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
