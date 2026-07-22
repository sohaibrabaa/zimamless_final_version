import { IsIn, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTOs mirror the frozen contract's schemas exactly. The shapes here are
 * what CI diffs against 03_API_CONTRACT.yaml via /docs-json, so a field
 * added for convenience is a build failure, not a nicety.
 */

export class SwitchContextDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  organizationId!: string;
}

export class SetLanguageDto {
  @ApiProperty({ enum: ['EN', 'AR'] })
  @IsIn(['EN', 'AR'])
  language!: 'EN' | 'AR';
}

export class UserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty() phoneNumber!: string;
  @ApiProperty({ enum: ['EN', 'AR'] }) preferredLanguage!: 'EN' | 'AR';
  @ApiProperty() mfaEnabled!: boolean;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] }) status!: string;
}

export class MembershipDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty() organizationName!: string;
  @ApiProperty({ enum: ['SUPPLIER', 'BANK', 'PLATFORM'] }) organizationType!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty() isAuthorizedSignatory!: boolean;
}

/**
 * D-10: the frontend must hide the time-machine control unless the API says
 * it is enabled. Present only when it is; absent entirely in production.
 */
export class DemoInfoDto {
  @ApiProperty() timeMachineEnabled!: boolean;
  @ApiProperty() currentOffsetDays!: number;
}

export class AuthMeDto {
  @ApiProperty({ type: UserDto }) user!: UserDto;
  @ApiProperty({ type: [MembershipDto] }) memberships!: MembershipDto[];
  @ApiProperty({ format: 'uuid', required: false }) activeOrganizationId?: string;
  @ApiProperty({ type: DemoInfoDto, required: false }) demo?: DemoInfoDto;
}
