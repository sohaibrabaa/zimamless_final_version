import { CanActivate, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';

/**
 * The env-flag half of the time machine's double guard, as a route guard.
 *
 * It must be a guard, not a service check: guards run before the validation
 * pipe and before any role decorator on this route is enforced elsewhere, so
 * with the flag off *every* response from this route is the same 404 — a
 * malformed body cannot earn a 400 and an insufficient role cannot earn a
 * 403, either of which would confirm to a production caller that a
 * clock-moving control exists. The service re-checks the same flag anyway;
 * defense in depth is the point of a double guard.
 */
@Injectable()
export class DemoAvailableGuard implements CanActivate {
  constructor(
    @Inject('DEMO_TIME_MACHINE_ENV_FLAG') private readonly envFlagEnabled: boolean,
  ) {}

  canActivate(): boolean {
    if (!this.envFlagEnabled) throw AppException.notFound('Resource');
    return true;
  }
}
