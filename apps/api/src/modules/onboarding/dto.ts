import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class RegisterDto {
  @ApiProperty({ example: '20000101' })
  @IsString()
  @MinLength(8)
  nationalEstablishmentNumber!: string;

  @ApiProperty({ example: 'GAM-20000101' })
  @IsString()
  @MinLength(3)
  professionLicenceNumber!: string;
}

export class RegisterResponseDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) applicationId!: string;
}

export class CreateApplicationDto extends RegisterDto {}

export class BankAccountDto {
  @ApiProperty({ example: 'JO94CBJO0010000000000131000302' })
  @IsString()
  iban!: string;

  @ApiProperty() @IsString() bankName!: string;
  @ApiProperty() @IsString() accountHolderName!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;
}

export class ConsentItemDto {
  @ApiProperty() @IsString() consentType!: string;
  @ApiProperty() @IsString() consentVersion!: string;
  @ApiProperty() @IsBoolean() granted!: boolean;
}

export class ConsentsDto {
  @ApiProperty({ type: [ConsentItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsentItemDto)
  consents!: ConsentItemDto[];
}

export class RespondDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() informationRequestId!: string;
  @ApiProperty() @IsString() @MinLength(1) response!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  documentIds?: string[];
}

const DECISIONS = ['APPROVED', 'APPROVED_CONDITIONAL', 'INFORMATION_REQUIRED', 'REJECTED'] as const;

export class DecideDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS as unknown as string[])
  decision!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() reasonCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  /** Names the item being asked for when the decision is INFORMATION_REQUIRED. */
  @ApiPropertyOptional() @IsOptional() @IsString() requestedItem?: string;
}

export class ListQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() status?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize = 20;
}

export class GovernmentLookupDto {
  @ApiProperty({ enum: ['CCD', 'ISTD', 'GAM', 'EINVOICE'] })
  @IsIn(['CCD', 'ISTD', 'GAM', 'EINVOICE'])
  source!: string;

  @ApiProperty() @IsString() lookupKey!: string;

  @ApiPropertyOptional({ enum: ['ORGANIZATION', 'BUYER', 'INVOICE'] })
  @IsOptional()
  @IsIn(['ORGANIZATION', 'BUYER', 'INVOICE'])
  subjectType?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;
}
