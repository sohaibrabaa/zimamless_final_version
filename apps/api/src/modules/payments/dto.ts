import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/** Money on the wire is a 3-dp string, never a JSON number (hard rule 2). */
const MONEY = /^\d{1,15}\.\d{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RecordPaymentDto {
  @ApiProperty({ example: '5000.000', description: 'A 3-dp string. Never a JSON number.' })
  @Matches(MONEY, {
    message: 'amount must be a decimal string with exactly three decimal places, e.g. "5000.000".',
  })
  amount!: string;

  @ApiProperty({ example: '2026-09-02', format: 'date' })
  @Matches(ISO_DATE, { message: 'paymentDate must be an ISO date, e.g. "2026-09-02".' })
  paymentDate!: string;

  @ApiPropertyOptional({ description: "The bank's own reference for the incoming payment." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankReference?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;

  @ApiPropertyOptional({
    description:
      "Bank-only working notes (ZM-PMT-018). Never returned to the supplier, and never " +
      'written to the audit trail.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bankInternalNotes?: string;
}

export class ConfirmStatusDto {
  @ApiProperty({
    enum: ['PAID', 'PARTIALLY_PAID', 'OVERDUE'],
    description:
      'The bank states what actually happened. OVERDUE is reachable only through this ' +
      'endpoint — a due date passing produces OVERDUE_UNCONFIRMED and nothing more ' +
      '(ZM-PMT-008..011).',
  })
  @IsIn(['PAID', 'PARTIALLY_PAID', 'OVERDUE'])
  status!: 'PAID' | 'PARTIALLY_PAID' | 'OVERDUE';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** The frozen `closure_reason` enum, verbatim. */
export const CLOSURE_REASONS = [
  'PAID_IN_FULL',
  'RECOURSE_SETTLED',
  'WRITTEN_OFF',
  'DEFAULTED',
  'CANCELLED_BEFORE_FUNDING',
  'SETTLED_BY_AGREEMENT',
  'OTHER',
] as const;

export class CloseTransactionDto {
  @ApiProperty({ enum: CLOSURE_REASONS })
  @IsIn(CLOSURE_REASONS as unknown as string[])
  closureReason!: (typeof CLOSURE_REASONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
