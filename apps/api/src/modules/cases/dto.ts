import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const MONEY = /^\d{1,15}\.\d{3}$/;

export const RECOURSE_REASONS = [
  'INVALID_INVOICE',
  'HIDDEN_DISPUTE_OR_RETURN',
  'DOUBLE_FINANCING',
  'NON_DELIVERY',
  'NON_PAYMENT',
  'OTHER',
] as const;

export const RECOURSE_STATUSES = [
  'SUPPLIER_NOTIFIED',
  'PAYMENT_PENDING',
  'SETTLED',
  'DISPUTED',
  'LEGAL_ESCALATION',
] as const;

export class InitiateRecourseDto {
  @ApiProperty({ enum: RECOURSE_REASONS })
  @IsIn(RECOURSE_REASONS as unknown as string[])
  reason!: (typeof RECOURSE_REASONS)[number];

  @ApiProperty({
    example: '9000.000',
    description:
      'A 3-dp string. Capped at the gross funding amount — a claim cannot recover more than ' +
      'the bank advanced (ZM-REC-004).',
  })
  @Matches(MONEY, { message: 'requestedAmount must be a 3-dp decimal string, e.g. "9000.000".' })
  requestedAmount!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  evidenceDocumentIds?: string[];
}

export class RepayRecourseDto {
  @ApiProperty({ example: '4500.000' })
  @Matches(MONEY, { message: 'amount must be a 3-dp decimal string, e.g. "4500.000".' })
  amount!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerReference?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;
}

export class RecourseStatusDto {
  @ApiProperty({ enum: RECOURSE_STATUSES })
  @IsIn(RECOURSE_STATUSES as unknown as string[])
  status!: (typeof RECOURSE_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class OpenDisputeDto {
  @ApiProperty({
    example: 'INVOICE_AUTHENTICITY',
    description: 'Free text: the parties describe what is contested, the platform does not classify it.',
  })
  @IsString()
  @MaxLength(100)
  disputeType!: string;

  @ApiProperty({ description: 'What is contested, in the raising party’s own words.' })
  @IsString()
  @MaxLength(4000)
  description!: string;

  @ApiPropertyOptional({ example: '4000.000' })
  @IsOptional()
  @Matches(MONEY, { message: 'amount must be a 3-dp decimal string, e.g. "4000.000".' })
  amount?: string;
}

export class ResolveDisputeDto {
  @ApiProperty({
    description:
      'What the parties agreed. Mandatory: the platform does not adjudicate (ZM-REC-012/014), ' +
      'so a dispute cannot be closed without someone stating what was decided.',
  })
  @IsString()
  @MaxLength(4000)
  resolutionNotes!: string;

  @ApiPropertyOptional({ enum: ['RESOLVED', 'REJECTED'], default: 'RESOLVED' })
  @IsOptional()
  @IsIn(['RESOLVED', 'REJECTED'])
  outcome?: 'RESOLVED' | 'REJECTED';
}

export const WITHDRAWAL_REASONS = [
  'BANK_COMMERCIAL_DECISION',
  'SUPPLIER_MISREPRESENTATION',
  'FRAUD_DISCOVERED',
  'INVOICE_CHANGED',
  'CONDITION_NOT_MET',
  'TECHNICAL_FAILURE',
  'OTHER',
] as const;

export class OpenWithdrawalDto {
  @ApiProperty({ enum: WITHDRAWAL_REASONS })
  @IsIn(WITHDRAWAL_REASONS as unknown as string[])
  reason!: (typeof WITHDRAWAL_REASONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class DecideWithdrawalDto {
  @ApiProperty({
    description:
      'The administrator’s decision, taken verbatim. The policy’s suggestion is a default to ' +
      'consider, never an answer that overrides a human who can see the commercial context.',
  })
  @IsBoolean()
  penaltyApplicable!: boolean;

  @ApiPropertyOptional({ example: '500.000' })
  @IsOptional()
  @Matches(MONEY, { message: 'penaltyAmount must be a 3-dp decimal string, e.g. "500.000".' })
  penaltyAmount?: string;

  @ApiProperty({
    description:
      'Whether the supplier may relist. A separate deliberate answer: the receivable returning ' +
      'to the marketplace is a decision, not a consequence (D-03).',
  })
  @IsBoolean()
  relistingEligible!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class OpenFraudReviewDto {
  @ApiProperty({ description: 'What prompted the review. Records suspicion, concludes nothing.' })
  @IsString()
  @MaxLength(4000)
  summary!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  indicators?: string[];
}

export const FRAUD_DECISIONS = ['CLEARED', 'RESTRICTED', 'SUSPENDED', 'BLACKLISTED', 'REPORTED'] as const;

export class DecideFraudDto {
  @ApiProperty({
    enum: FRAUD_DECISIONS,
    description:
      'ZM-FRD-004: this is the only thing in the system that records a confirmed status. ' +
      'An indicator is someone noticing something; a finding is a qualified human concluding ' +
      'something.',
  })
  @IsIn(FRAUD_DECISIONS as unknown as string[])
  decision!: (typeof FRAUD_DECISIONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}
