import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Money } from '../../common/money/money';

/**
 * The payout rail, behind an interface (ZM-FND-013/014, ZM-ARC adapter rule).
 *
 * Nothing in the domain names `DummySettlementProvider`. It is bound to
 * `SETTLEMENT_PROVIDER` in the module, so swapping in a real rail — a bank
 * API, a payment processor — is a one-line change there and nothing else. If
 * a domain service ever imports the concrete class, that claim quietly stops
 * being true, which is why the symbol exists.
 *
 * ## The split
 *
 * The request carries all three legs, not just the net. A real rail executes
 * this as a split instruction: the supplier receives the net, and the
 * platform's commission and listing fee are directed to the platform. The
 * platform never receives the gross and then pays out — that would make it a
 * money holder, which ZM-CON-013 says it is not.
 *
 * ## Idempotency (INV-13)
 *
 * `idempotencyKey` is the settlement id, stable for the settlement's whole
 * life. Every retry presents the same key, so a rail that honours it cannot
 * pay twice however many times it is asked. That is the outer guarantee; the
 * inner one is `SettlementService`, which will not call a provider at all for
 * an already-completed settlement.
 */

export const SETTLEMENT_PROVIDER = Symbol('SETTLEMENT_PROVIDER');

export interface PayoutRequest {
  /** The settlement id. Stable across retries — never regenerated (INV-13). */
  idempotencyKey: string;
  netPayout: Money;
  commission: Money;
  listingFee: Money;
  supplierOrgId: string;
  bankOrgId: string;
  attemptNo: number;
}

export interface PayoutResult {
  succeeded: boolean;
  providerReference: string | null;
  failureReason: string | null;
  /** Whatever the rail returned, stored verbatim on the attempt for evidence. */
  raw: Record<string, unknown>;
}

export interface SettlementProvider {
  readonly name: string;
  execute(request: PayoutRequest): Promise<PayoutResult>;
}

/**
 * The development rail.
 *
 * It does not pretend to move money and does not fake a plausible-looking
 * banking response — it records that it was asked, and succeeds. The one piece
 * of real behaviour it implements is **idempotency**: a key it has already
 * settled returns the original reference rather than a new one, so the
 * dummy exercises the same contract a real rail would.
 *
 * ## Forcing a failure
 *
 * The Phase 7 checkpoint requires a payout-failure drill. Rather than a
 * special test-only code path, the provider reads a demo setting —
 * `demo_force_payout_failure` — so the drill can be performed live, in the
 * demo, through the same code the happy path uses. It is guarded by the same
 * `demo_time_machine_enabled` flag as the rest of the demo controls, so it
 * cannot be switched on in production.
 */
@Injectable()
export class DummySettlementProvider implements SettlementProvider {
  readonly name = 'DUMMY';

  /** Keys this provider has already settled, with the reference it issued. */
  private readonly settled = new Map<string, string>();

  constructor(private readonly db: DatabaseService) {}

  async execute(request: PayoutRequest): Promise<PayoutResult> {
    const existing = this.settled.get(request.idempotencyKey);
    if (existing) {
      // Asked again for a key it has already paid: the same reference, and no
      // second payout. A real rail behaves this way; the dummy must too, or it
      // would be a weaker contract than the thing it stands in for.
      return {
        succeeded: true,
        providerReference: existing,
        failureReason: null,
        raw: { replayed: true, idempotencyKey: request.idempotencyKey },
      };
    }

    if (await this.failureForced()) {
      return {
        succeeded: false,
        providerReference: null,
        failureReason: 'DEMO_FORCED_FAILURE',
        raw: { forced: true, attemptNo: request.attemptNo },
      };
    }

    const reference = `DUMMY-${request.idempotencyKey.slice(0, 8).toUpperCase()}`;
    this.settled.set(request.idempotencyKey, reference);

    return {
      succeeded: true,
      providerReference: reference,
      failureReason: null,
      raw: {
        attemptNo: request.attemptNo,
        netPayout: request.netPayout.toString(),
        commission: request.commission.toString(),
        listingFee: request.listingFee.toString(),
      },
    };
  }

  /**
   * Both flags must be true, exactly like the time machine: a demo control
   * that could be switched on by a single setting in production is not a demo
   * control, it is a way to break live payouts.
   */
  private async failureForced(): Promise<boolean> {
    const { rows } = await this.db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM platform_settings
        WHERE key IN ('demo_force_payout_failure','demo_time_machine_enabled')`,
    );
    const on = (key: string): boolean => rows.find((r) => r.key === key)?.value === true;
    return on('demo_time_machine_enabled') && on('demo_force_payout_failure');
  }

  /** Test seam: forget what has been settled. Never called by domain code. */
  reset(): void {
    this.settled.clear();
  }
}
