import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

const MONEY = /^-?\d+\.\d{3}$/;

// PATCH /admin/settings takes a free-form `{ key: value }` body (the contract
// declares `additionalProperties: true`), so it is typed as a plain record in
// the controller rather than a DTO — a whitelisting DTO would strip exactly the
// arbitrary keys the endpoint exists to accept. The service validates each key
// against the settings that actually exist.

export class CreateCommissionTierDto {
  @ApiProperty({ example: '0.000' })
  @IsString()
  @Matches(MONEY, { message: 'minTransactionAmount must be a 3-decimal money string.' })
  minTransactionAmount!: string;

  @ApiProperty({ required: false, example: '50000.000' })
  @IsOptional()
  @IsString()
  @Matches(MONEY, { message: 'maxTransactionAmount must be a 3-decimal money string.' })
  maxTransactionAmount?: string;

  @ApiProperty({ example: 2.5 })
  @IsNumber()
  @Min(0)
  commissionPercentage!: number;

  @ApiProperty({ required: false, example: '0.000' })
  @IsOptional()
  @IsString()
  @Matches(MONEY, { message: 'fixedCommissionAmount must be a 3-decimal money string.' })
  fixedCommissionAmount?: string;

  @ApiProperty({ enum: ['SUPPLIER', 'BANK', 'SPLIT', 'CUSTOM'] })
  @IsIn(['SUPPLIER', 'BANK', 'SPLIT', 'CUSTOM'])
  feePayer!: string;

  @ApiProperty({ required: false, format: 'date-time' })
  @IsOptional()
  @IsString()
  effectiveFrom?: string;
}

