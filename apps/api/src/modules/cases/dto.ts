import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

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
