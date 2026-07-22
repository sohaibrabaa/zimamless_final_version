import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DatabaseService } from '../../database/database.service';
import { Public } from '../auth/decorators';

/**
 * Liveness/readiness probe.
 *
 * Deliberately excluded from the OpenAPI document. GET /health is required
 * by the Phase 1 task list but does not appear in 03_API_CONTRACT.yaml, and
 * the CI conformance gate fails the build on any divergence between
 * /docs-json and the frozen contract. Publishing it would therefore break
 * the gate; it is operational infrastructure, not part of the API seam that
 * Agent B generates a client from.
 *
 * Recorded as a reading in the daily log rather than resolved silently.
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @Public()
  async check(): Promise<{ status: string; database: string; uptimeSeconds: number }> {
    let database = 'ok';
    try {
      await this.db.query('SELECT 1');
    } catch {
      // Reported rather than thrown: a probe that 500s tells a load balancer
      // to remove the instance, but tells an operator nothing about why.
      database = 'unavailable';
    }

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
