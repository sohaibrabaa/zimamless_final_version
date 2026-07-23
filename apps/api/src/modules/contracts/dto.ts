import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Phase 6 request bodies.
 *
 * `/offers/{id}/accept` and `/listings/{id}/reject-all` have none, and that
 * is deliberate rather than an omission: acceptance takes no parameters
 * because every commercial term is already fixed on the offer. A body would
 * invite a client to restate a figure, and a restated figure is a figure that
 * can disagree.
 */

export class SignContractDto {
  @ApiProperty({
    description:
      'Explicit assent. `false` is not a signature — declining is a cancellation request, ' +
      'not a silent no-op.',
  })
  @IsBoolean()
  accepted!: boolean;
}

export class FulfilConditionDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Evidence documents. Each must already be attached to this transaction.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  documentIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Bank only. Present means "waive this condition"; the reason is the record ZM-CON-006 ' +
      'requires, so it cannot be blank.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  waiverReason?: string;
}
