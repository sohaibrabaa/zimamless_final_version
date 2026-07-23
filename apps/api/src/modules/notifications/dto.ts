import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /notifications/{id}/manual-call` (Q-17, additive).
 *
 * `notes` is required and cannot be blank. A manual-call record whose outcome
 * is empty asserts that a conversation happened and says nothing about it,
 * which is worse than no record — ZM-NOT-007 asks for the *outcome*, and an
 * empty string would satisfy the column while defeating the requirement.
 */
export class RecordManualCallDto {
  @ApiProperty({
    description: 'What was said and what came of it. Retained verbatim in the audit trail.',
    minLength: 1,
    maxLength: 4000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  notes!: string;
}
