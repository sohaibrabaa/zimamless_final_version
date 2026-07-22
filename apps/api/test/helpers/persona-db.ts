import { Client } from 'pg';

/**
 * Connects to Postgres AS A PERSONA, with NestJS entirely out of the picture.
 *
 * This is the point of the whole RLS suite. ZM-ARC-005 and Master Plan 5.3
 * are explicit: a policy that passes only because NestJS filtered first is a
 * defect, so the test must reach the database the way a Supabase client
 * would — holding a user's JWT and nothing else.
 *
 * Supabase's auth.uid() reads the `request.jwt.claims` GUC, which is what
 * PostgREST sets from the bearer token. Setting the same GUC and switching
 * to the `authenticated` role reproduces that path exactly, without needing
 * to mint signed tokens or route through PostgREST. The connection itself is
 * made with the admin credentials, then immediately downgraded — a real
 * session cannot escalate back, because SET ROLE is inside a transaction
 * that the helper controls.
 */
export class PersonaDb {
  private constructor(
    private readonly client: Client,
    readonly label: string,
  ) {}

  static async connect(connectionString: string, label: string): Promise<PersonaDb> {
    const needsTls = /supabase\.(com|co)/.test(connectionString) || process.env.PGSSLMODE === 'require';
    const client = new Client({
      connectionString,
      ssl: needsTls ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    return new PersonaDb(client, label);
  }

  /**
   * Run a query as the given auth user under the `authenticated` role.
   *
   * Everything happens inside a transaction that is always rolled back:
   * SET LOCAL confines the role and claims to it, and no test can leave
   * state behind for the next one.
   */
  async asUser<T = Record<string, unknown>>(
    authUserId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await this.client.query('BEGIN');
    try {
      await this.client.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: authUserId, role: 'authenticated' })],
      );
      await this.client.query('SET LOCAL ROLE authenticated');
      const result = await this.client.query(sql, params);
      return result.rows as T[];
    } finally {
      await this.client.query('ROLLBACK');
    }
  }

  /**
   * Like asUser, but expects the statement to be REJECTED. Returns the
   * Postgres error message.
   *
   * Needed because column-level revokes (D-02's floor, otp_hash,
   * bank_internal_notes) surface as a permission error rather than as zero
   * rows — and "zero rows" would be a much weaker assertion, since it is
   * also what an empty table returns.
   */
  async expectRejected(authUserId: string, sql: string, params: unknown[] = []): Promise<string> {
    try {
      await this.asUser(authUserId, sql, params);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error(
      `Expected the statement to be rejected for ${this.label}, but it succeeded:\n  ${sql}`,
    );
  }

  /** Admin read, for arranging fixtures and reading expected values. */
  async asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/**
 * Seeded auth ids from db/seed/0100_seed_dev.sql. Fixed literals, so the
 * suite does not have to look them up and cannot silently test the wrong
 * person if the seed is re-run.
 */
export const PERSONA = {
  supplierAlNoorOwner: '0e200000-0000-4000-8000-000000000001',
  supplierPetraOwner: '0e200000-0000-4000-8000-000000000003',
  bankAMaker: '0e200000-0000-4000-8000-000000000005',
  bankAApprover: '0e200000-0000-4000-8000-000000000006',
  bankBMaker: '0e200000-0000-4000-8000-000000000008',
  bankBOps: '0e200000-0000-4000-8000-00000000000a',
  platformAdmin: '0e200000-0000-4000-8000-00000000000c',
  multiOrg: '0e200000-0000-4000-8000-00000000000f',
} as const;

export const ORG = {
  platform: '0e000000-0000-4000-8000-000000000001',
  alNoor: '0e000000-0000-4000-8000-000000000002',
  petra: '0e000000-0000-4000-8000-000000000003',
  bankA: '0e000000-0000-4000-8000-000000000004',
  bankB: '0e000000-0000-4000-8000-000000000005',
  bankC: '0e000000-0000-4000-8000-000000000006',
} as const;
