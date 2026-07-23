import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * `POST /admin/risk-models`.
 *
 * The contract's request schema is `RiskModelVersion` itself, which declares
 * read-only-ish fields (`isActive`, `createdAt`) alongside configuration. This
 * DTO accepts only the fields an administrator may actually set — the server
 * assigns the id, the timestamps, the activating user, and the effective
 * window. A create body that could set `createdAt` would be a create body that
 * could backdate a model version.
 */

export class ComponentWeightsDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  supplierVerification?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  dataConfidence?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  buyerProfile?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  invoiceScore?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  platformBehavior?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description:
      'Share of the composite the trained model may move. Kept a minority ' +
      'because the model is trained on synthetic data (ZM-RSK-016).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  ml?: number;
}

export class BandThresholdsDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  LOW?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  MEDIUM?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  HIGH?: number;
}

export class CreateRiskModelDto {
  @ApiProperty({ example: 'risk-logreg-1.0+seed20260723' })
  @IsString()
  @MinLength(3)
  @Matches(/^[A-Za-z0-9._+-]+$/, {
    message: 'versionLabel may contain letters, digits, dot, underscore, plus and hyphen only.',
  })
  versionLabel!: string;

  @ApiProperty({ enum: ['RULES', 'ML', 'HYBRID'] })
  @IsIn(['RULES', 'ML', 'HYBRID'])
  modelType!: 'RULES' | 'ML' | 'HYBRID';

  @ApiPropertyOptional({ type: ComponentWeightsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ComponentWeightsDto)
  weights?: ComponentWeightsDto;

  @ApiPropertyOptional({ type: BandThresholdsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BandThresholdsDto)
  bandThresholds?: BandThresholdsDto;

  @ApiPropertyOptional({ description: 'Recorded metrics from the training run (ZM-RSK-017).' })
  @IsOptional()
  @IsObject()
  trainingMetrics?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Activate on creation. Requires activationReason.' })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;

  @ApiPropertyOptional({
    description: 'Why this version is being activated. Required when activate is true (ZM-RSK-011).',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  activationReason?: string;
}
