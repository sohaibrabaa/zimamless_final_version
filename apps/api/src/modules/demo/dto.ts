import { ApiProperty } from '@nestjs/swagger';
import { IsInt } from 'class-validator';

/**
 * `POST /demo/time-travel` body.
 *
 * `offsetDays` is a whole-day, absolute offset (0 returns to real time). The
 * time machine deliberately has no finer resolution — sub-day demos (a
 * 15-minute OTP expiry) belong to `FixedTimeProvider` in unit tests, not to a
 * clock a judge is watching move in day steps.
 */
export class TimeTravelDto {
  @ApiProperty({ description: 'Absolute day offset from real time; 0 is now.', example: 45 })
  @IsInt()
  offsetDays!: number;
}
