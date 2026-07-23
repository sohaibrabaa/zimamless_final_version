import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BuyerContactInputDto } from '../buyers/dto';
import { MONEY_MESSAGE, MONEY_PATTERN } from '../../common/money/money';

/**
 * The contract's Money pattern, applied at the edge.
 *
 * Rejecting a malformed amount here rather than inside `Money.from()` turns
 * what would be a 500 into the contract's 422 with a named field. Money is a
 * 3-dp string on every wire in this system; a JSON number is a contract
 * violation by the producer, not something to coerce.
 *
 * The expression itself lives beside `Money` now rather than here, because
 * Phase 5 needed the same one and a second copy is how the validator at the
 * edge and the parser in the service start disagreeing.
 */
const MONEY = MONEY_PATTERN;

export class InvoiceItemDto {
  @ApiProperty() @IsString() @MinLength(1) description!: string;
  @ApiProperty({ example: '1200.000' }) @Matches(MONEY, { message: `quantity ${MONEY_MESSAGE}` }) quantity!: string;
  @ApiProperty({ example: '8.500' }) @Matches(MONEY, { message: `unitPrice ${MONEY_MESSAGE}` }) unitPrice!: string;
  @ApiProperty({ example: '10200.000' }) @Matches(MONEY, { message: `lineAmount ${MONEY_MESSAGE}` }) lineAmount!: string;
}

export class InvoiceInputDto {
  @ApiProperty({ example: 'INV-2026-0001' }) @IsString() @MinLength(1) invoiceNumber!: string;

  /** ZM-DOC-001: mandatory in V3. */
  @ApiProperty({ example: 'JO-EINV-20000101-0001' })
  @IsString()
  @MinLength(1)
  einvoiceIdentifier!: string;

  @ApiProperty({ example: '2026-05-10' }) @IsDateString() issueDate!: string;
  @ApiProperty({ example: '2026-08-10' }) @IsDateString() dueDate!: string;

  @ApiProperty({ example: '10650.000' })
  @Matches(MONEY, { message: `subtotalAmount ${MONEY_MESSAGE}` })
  subtotalAmount!: string;

  @ApiProperty({ example: '1704.000' })
  @Matches(MONEY, { message: `taxAmount ${MONEY_MESSAGE}` })
  taxAmount!: string;

  @ApiProperty({ example: '12354.000' })
  @Matches(MONEY, { message: `faceValue ${MONEY_MESSAGE}` })
  faceValue!: string;

  @ApiPropertyOptional({ example: '0.000' })
  @IsOptional()
  @Matches(MONEY, { message: `paidAmount ${MONEY_MESSAGE}` })
  paidAmount?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() paymentTerms?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() goodsDescription?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() purchaseOrderNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryNoteNumber?: string;

  @ApiPropertyOptional({ type: [InvoiceItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items?: InvoiceItemDto[];
}

export class LinkBuyerDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() buyerId!: string;

  @ApiPropertyOptional({ type: BuyerContactInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyerContactInputDto)
  contact?: BuyerContactInputDto;
}

export class MinimumAmountDto {
  /**
   * The minimum NET amount the supplier will accept — not a gross floor.
   * Never disclosed to any bank (INV-8 / ZM-MKT-012).
   */
  @ApiProperty({ example: '11000.000' })
  @Matches(MONEY, { message: `minimumAcceptableAmount ${MONEY_MESSAGE}` })
  minimumAcceptableAmount!: string;
}

/**
 * All eight declarations (ZM-INV-004, LT-04).
 *
 * Typed as plain booleans rather than `Equals(true)` deliberately. "Every
 * declaration must be affirmed" is a business rule, not a statement about
 * the request's shape, and the two produce different statuses here: a
 * malformed body is a 400 from the validation pipe, while a business rule
 * refused is the contract's 422. Encoding the rule in the DTO would make
 * the single most consequential refusal in the whole submission flow come
 * back as a shape error.
 *
 * `TransactionsService.recordDeclarations` enforces it and answers 422 with
 * the list of declarations that were not affirmed, which is also a far more
 * useful error than "isAuthentic must equal true". The database enforces it
 * a third time (`chk_all_declared`).
 */
export class DeclarationInputDto {
  @ApiProperty({ example: '1.0' })
  @IsString()
  @MinLength(1)
  declarationTemplateVersion!: string;

  @ApiProperty({ enum: [true] }) @IsBoolean() isAuthentic!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() goodsDelivered!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() unpaidAndNotCancelled!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() noKnownDispute!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() notPreviouslyFinanced!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() buyerIsNamedEntity!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() contactIsBuyerRep!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() acceptsRecourse!: boolean;
}

export class CancelTransactionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class RelistRequestDto {
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class TransactionListQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;

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
