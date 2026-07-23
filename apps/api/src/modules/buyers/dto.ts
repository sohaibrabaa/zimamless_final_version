import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class BuyerSearchQueryDto {
  @ApiProperty({ minLength: 2, example: 'Amman Retail' })
  @IsString()
  @MinLength(2)
  q!: string;
}

export class BuyerContactInputDto {
  @ApiProperty() @IsString() @MinLength(1) contactName!: string;

  /** Accountant, purchasing, manager, owner, other (§7.2). */
  @ApiProperty() @IsString() @MinLength(1) contactRole!: string;

  @ApiProperty() @IsString() @MinLength(6) contactPhone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;
}

export class ResolveBuyerDto {
  @ApiProperty({ example: '30000201' })
  @IsString()
  @MinLength(8)
  nationalEstablishmentNumber!: string;

  /**
   * Must be true. Typed as a boolean rather than accepted implicitly so the
   * client has to state the supplier's confirmation — ZM-BUY-009 forbids the
   * platform selecting a buyer, and an absent field would be the platform
   * deciding on the supplier's behalf.
   */
  @ApiProperty({ description: 'Must be true — explicit supplier confirmation.' })
  @IsBoolean()
  confirmedByUser!: boolean;

  @ApiPropertyOptional({ type: BuyerContactInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyerContactInputDto)
  contact?: BuyerContactInputDto;
}
