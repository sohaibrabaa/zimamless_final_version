import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { DOCUMENT_TYPES } from './documents.service';
import { ALLOWED_MIME_TYPES } from './storage.service';

export class UploadUrlDto {
  @ApiProperty({ enum: DOCUMENT_TYPES as unknown as string[] })
  @IsIn(DOCUMENT_TYPES as unknown as string[])
  documentType!: string;

  @ApiProperty({ example: 'invoice-2026-0001.pdf' })
  @IsString()
  @MinLength(1)
  fileName!: string;

  @ApiProperty({ enum: ALLOWED_MIME_TYPES as string[] })
  @IsIn(ALLOWED_MIME_TYPES as string[])
  mimeType!: string;

  @ApiProperty({ example: 148213 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @ApiPropertyOptional({ enum: ['TRANSACTION', 'SUPPLIER_APPLICATION'] })
  @IsOptional()
  @IsIn(['TRANSACTION', 'SUPPLIER_APPLICATION'])
  subjectType?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;
}
