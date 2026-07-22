import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppConfig } from '../config/configuration';

/**
 * The API's connection to Postgres, using the service role.
 *
 * This connection BYPASSES RLS by design: NestJS is the primary
 * authorization layer (ZM-ARC-003..005) and RLS is the independent backup
 * that protects direct-SQL clients using anon/authenticated JWTs. That split
 * is why the RLS suite must connect separately, as each persona, rather than
 * through this pool — a policy that passes only because this layer filtered
 * first is a defect.
 *
 * Consequence: every query issued here is responsible for its own scoping.
 * There is no safety net underneath it.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool!: Pool;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.database.url;
    const needsTls = /supabase\.(com|co)/.test(url) || process.env.PGSSLMODE === 'require';

    this.pool = new Pool({
      connectionString: url,
      ssl: needsTls ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    this.pool.on('error', (err) => {
      // An idle client erroring is not tied to a request, so it would
      // otherwise vanish silently.
      this.logger.error(`Idle database client error: ${err.message}`);
    });

    // Fail fast at boot rather than on the first request.
    const probe = await this.pool.connect();
    try {
      await probe.query('SELECT 1');
      this.logger.log('Database connection established.');
    } finally {
      probe.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.pool.query<T>(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  /** Convenience for single-row reads. Returns null rather than throwing. */
  async queryOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const { rows } = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /**
   * Run a function inside a single transaction, on a single client.
   *
   * Required wherever atomicity is an invariant rather than a nicety — most
   * of all offer acceptance (INV-1), where the whole lock/select/snapshot
   * sequence has to commit or vanish together. Rolls back on any throw.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // A rollback failure means the connection is already broken; the
        // original error is the one worth surfacing.
      });
      throw err;
    } finally {
      client.release();
    }
  }
}
