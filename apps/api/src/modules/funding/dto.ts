import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
