import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class MarkSentDto {
  @ApiPropertyOptional({
    description: "The bank's own reference for the transfer, for reconciliation.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerReference?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A document the bank has already uploaded as evidence of the transfer. It must belong ' +
      'to the bank; it is attached to the transaction so both parties can see it.',
  })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;
}

export class ConfirmFundingDto {
  @ApiProperty({
    description: 'The one-time code the bank issued and passed to the supplier out of band.',
  })
  @IsString()
  @IsNotEmpty()
  // Deliberately no length or format validator. A "must be 6 digits" rejection
  // would answer a question about the code's shape before any attempt is
  // counted, which is a free oracle and an attempt-budget bypass. Malformed
  // input is simply a wrong code (ZM-FND-009).
  @MaxLength(64)
  otp!: string;
}
