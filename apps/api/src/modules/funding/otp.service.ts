import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { RequestContextStore } from '../../common/context/request-context';
import { plusSeconds } from '../../common/time/business-time';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * The cross-party funding OTP (ZM-FND-004..009).
 *
 * ## What it is, and what it is not
 *
 * ZM-FND-008 is unusually direct: the OTP "is explicitly **not** a digital
 * signature and carries **no** legal signing authority. Its sole purpose is
 * cross-party synchronization of the funding confirmation event."
 *
 * That is worth taking literally, because it sets the security bar honestly.
 * This mechanism proves that someone at the supplier received a code the bank
 * generated and passed along out of band. It does not cryptographically bind
 * the supplier to anything — a bank employee who has the code could enter it
 * themselves. What it buys is that funding cannot complete on one party's say
 * so alone, which is defining behaviour #5. Treating it as stronger than that
 * would be the mistake.
 *
 * ## Storage
 *
 * ZM-FND-005: hash only. The code is six digits, so a bare SHA-256 would be
 * exhaustible in a million guesses by anyone who obtained the column. It is
 * therefore an **HMAC keyed with the server's encryption key** — an attacker
 * with the database but not the key cannot reverse it, and the column is also
 * revoked from `authenticated` (the RLS suite asserts that).
 *
 * The plaintext exists in exactly one place: the response to the bank user who
 * generated it. It is never logged, never stored, never returned again.
 *
 * ## Failure responses tell you nothing
 *
 * ZM-FND-009: wrong, expired, and already-used are indistinguishable to the
 * caller — one generic code, one generic message, plus the remaining attempt
 * count, which the requirement explicitly permits. Every branch in `verify`
 * that fails funnels through `genericFailure()` so a future edit cannot add a
 * more "helpful" message to one of them.
 */

export interface OtpRow {
  id: string;
  transaction_id: string;
  otp_hash: string;
  generated_by: string;
  generated_at: Date;
  expires_at: Date;
  status: 'PENDING_GENERATION' | 'SENT' | 'VERIFIED' | 'EXPIRED' | 'FAILED_MAX_ATTEMPTS';
  attempt_count: number;
  max_attempts: number;
  resend_count: number;
  max_resends: number;
  verified_at: Date | null;
  verified_by: string | null;
}

export interface GeneratedOtp {
  /** Plaintext. Returned once, to the generating bank user, and never again. */
  otp: string;
  expiresAt: Date;
  resendsRemaining: number;
}

interface OtpSettings {
  validityMinutes: number;
  maxAttempts: number;
  maxResends: number;
}

@Injectable()
export class OtpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // =====================================================================
  // Generation
  // =====================================================================

  /**
   * Generate (or regenerate) the OTP for a transaction.
   *
   * One row per transaction, updated on resend rather than a new row each
   * time: the attempt budget belongs to the confirmation event, not to a
   * particular code. See `verify` for why attempts are not reset on resend.
   */
  async generate(transactionId: string, ctx: ActorContext): Promise<GeneratedOtp> {
    const settings = await this.settings();
    const now = this.time.now();
    // `plusSeconds`, not `new Date(now.getTime() + …)`: the lint rule bans the
    // constructor in domain code, and it is right to — the shared helper is
    // how every other deadline in this codebase is derived.
    const expiresAt = plusSeconds(now, settings.validityMinutes * 60);

    const code = this.newCode();
    const hash = this.hash(code, transactionId);

    return this.db.transaction(async (client) => {
      const { rows: existingRows } = await client.query<OtpRow>(
        `SELECT * FROM funding_otps WHERE transaction_id = $1 FOR UPDATE`,
        [transactionId],
      );
      const existing = existingRows[0];

      if (existing) {
        if (existing.status === 'VERIFIED') {
          throw new AppException(
            ErrorCode.INVALID_STATE_TRANSITION,
            'This funding has already been confirmed.',
            HttpStatus.CONFLICT,
          );
        }
        if (existing.status === 'FAILED_MAX_ATTEMPTS') {
          // Regeneration cannot rescue an exhausted attempt budget, or the cap
          // would be advisory: ask for a new code, get five more guesses.
          throw new AppException(
            ErrorCode.OTP_MAX_ATTEMPTS,
            'The confirmation attempt limit has been reached. Platform support must intervene.',
            HttpStatus.CONFLICT,
          );
        }
        if (existing.resend_count >= existing.max_resends) {
          throw new AppException(
            ErrorCode.OTP_MAX_ATTEMPTS,
            'The maximum number of code regenerations has been reached.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        const { rows } = await client.query<OtpRow>(
          `UPDATE funding_otps
              SET otp_hash = $2, generated_by = $3, generated_at = $4, expires_at = $5,
                  status = 'SENT', resend_count = resend_count + 1
            WHERE id = $1
          RETURNING *`,
          [existing.id, hash, ctx.userId, now, expiresAt],
        );
        await this.recordEvent(client, rows[0].id, 'RESENT', ctx.userId);

        return {
          otp: code,
          expiresAt,
          resendsRemaining: rows[0].max_resends - rows[0].resend_count,
        };
      }

      const { rows } = await client.query<OtpRow>(
        `INSERT INTO funding_otps
           (transaction_id, otp_hash, generated_by, generated_at, expires_at,
            status, max_attempts, max_resends)
         VALUES ($1,$2,$3,$4,$5,'SENT',$6,$7)
         RETURNING *`,
        [
          transactionId,
          hash,
          ctx.userId,
          now,
          expiresAt,
          settings.maxAttempts,
          settings.maxResends,
        ],
      );
      await this.recordEvent(client, rows[0].id, 'GENERATED', ctx.userId);

      return { otp: code, expiresAt, resendsRemaining: rows[0].max_resends };
    });
  }

  // =====================================================================
  // Verification
  // =====================================================================

  /**
   * Check a code. Returns the verified row, or throws a generic failure.
   *
   * Runs inside the caller's transaction so that a successful verification and
   * whatever it unlocks (the FUNDED transition) commit together.
   */
  async verifyIn(
    client: PoolClient,
    transactionId: string,
    ctx: ActorContext,
    code: string,
  ): Promise<OtpRow> {
    const now = this.time.now();

    const { rows } = await client.query<OtpRow>(
      `SELECT * FROM funding_otps WHERE transaction_id = $1 FOR UPDATE`,
      [transactionId],
    );
    const otp = rows[0];

    // No code has been generated. Indistinguishable from a wrong one.
    if (!otp) throw this.genericFailure(0);

    if (otp.status === 'VERIFIED') {
      // Single use (ZM-FND-005). Replaying a correct code is still a failure,
      // and says nothing about the code having been correct.
      throw this.genericFailure(this.remaining(otp));
    }
    if (otp.status === 'FAILED_MAX_ATTEMPTS') {
      throw this.genericFailure(0);
    }

    if (otp.expires_at.getTime() <= now.getTime()) {
      if (otp.status !== 'EXPIRED') {
        await client.query(`UPDATE funding_otps SET status = 'EXPIRED' WHERE id = $1`, [otp.id]);
        await this.recordEvent(client, otp.id, 'EXPIRED', ctx.userId);
      }
      throw this.genericFailure(this.remaining(otp));
    }

    if (otp.attempt_count >= otp.max_attempts) {
      await client.query(
        `UPDATE funding_otps SET status = 'FAILED_MAX_ATTEMPTS' WHERE id = $1`,
        [otp.id],
      );
      throw this.genericFailure(0);
    }

    if (!this.matches(code, transactionId, otp.otp_hash)) {
      const attempts = otp.attempt_count + 1;
      const exhausted = attempts >= otp.max_attempts;
      await client.query(
        `UPDATE funding_otps
            SET attempt_count = $2, status = $3
          WHERE id = $1`,
        [otp.id, attempts, exhausted ? 'FAILED_MAX_ATTEMPTS' : otp.status],
      );
      await this.recordEvent(client, otp.id, 'ATTEMPT_FAILED', ctx.userId);
      throw this.genericFailure(Math.max(otp.max_attempts - attempts, 0));
    }

    const { rows: verified } = await client.query<OtpRow>(
      `UPDATE funding_otps
          SET status = 'VERIFIED', verified_at = $2, verified_by = $3
        WHERE id = $1
      RETURNING *`,
      [otp.id, now, ctx.userId],
    );
    await this.recordEvent(client, otp.id, 'VERIFIED', ctx.userId);
    return verified[0];
  }

  async findByTransaction(transactionId: string): Promise<OtpRow | null> {
    return this.db.queryOne<OtpRow>(
      `SELECT * FROM funding_otps WHERE transaction_id = $1`,
      [transactionId],
    );
  }

  /** INV-10's first half: is there a verified confirmation from the supplier? */
  isVerified(otp: OtpRow | null): boolean {
    return otp !== null && otp.status === 'VERIFIED';
  }

  // =====================================================================
  // Internals
  // =====================================================================

  /**
   * A six-digit code from a cryptographically secure source.
   *
   * `randomInt` rather than `Math.random()`: the codes must not be predictable
   * from one another, and `Math.random` is a PRNG whose state can be recovered
   * from a handful of outputs.
   */
  private newCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /**
   * Keyed hash, bound to the transaction.
   *
   * Including the transaction id means a code captured for one transaction
   * cannot be replayed against another even if it happens to collide — the
   * "bound to one specific transaction" half of ZM-FND-005, enforced by the
   * hash rather than only by the WHERE clause.
   */
  private hash(code: string, transactionId: string): string {
    return createHmac('sha256', this.config.encryptionKey)
      .update(`${transactionId}:${code}`)
      .digest('hex');
  }

  /** Constant-time comparison — a byte-by-byte early exit is a timing oracle. */
  private matches(code: string, transactionId: string, storedHash: string): boolean {
    const candidate = Buffer.from(this.hash(code, transactionId), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    if (candidate.length !== stored.length) return false;
    return timingSafeEqual(candidate, stored);
  }

  private remaining(otp: OtpRow): number {
    return Math.max(otp.max_attempts - otp.attempt_count, 0);
  }

  /**
   * The only failure this class produces (ZM-FND-009).
   *
   * One code, one message, whatever went wrong. `attemptsRemaining` is the
   * single permitted piece of detail. 401 is the contract's choice of status
   * for a bad OTP, which is why D-14 tells clients to branch on `code` rather
   * than on the HTTP status.
   */
  private genericFailure(attemptsRemaining: number): AppException {
    return new AppException(
      ErrorCode.OTP_INVALID,
      'That confirmation code is not valid.',
      HttpStatus.UNAUTHORIZED,
      { attemptsRemaining },
    );
  }

  /**
   * ZM-FND-007: every lifecycle event, with actor and IP.
   *
   * The IP comes from the request context rather than being passed down
   * through every signature, and is null for anything a job does — which is
   * accurate, rather than a fabricated address.
   */
  private async recordEvent(
    client: PoolClient,
    otpId: string,
    event: 'GENERATED' | 'RESENT' | 'ATTEMPT_FAILED' | 'VERIFIED' | 'EXPIRED',
    actorUserId: string | null,
  ): Promise<void> {
    const ip = RequestContextStore.get()?.ipAddress ?? null;
    await client.query(
      `INSERT INTO funding_otp_events (otp_id, event, actor_user_id, ip_address, occurred_at)
       VALUES ($1,$2,$3,$4::inet,$5)`,
      [otpId, event, actorUserId, ip, this.time.now()],
    );
  }

  /** ZM-FND-004/006: the policy is configuration, not constants in code. */
  private async settings(): Promise<OtpSettings> {
    const { rows } = await this.db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM platform_settings
        WHERE key IN ('otp_validity_minutes','otp_max_attempts','otp_max_resends')`,
    );
    const read = (key: string, fallback: number): number => {
      const raw = rows.find((r) => r.key === key)?.value;
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
      validityMinutes: read('otp_validity_minutes', 15),
      maxAttempts: read('otp_max_attempts', 5),
      maxResends: read('otp_max_resends', 3),
    };
  }
}
