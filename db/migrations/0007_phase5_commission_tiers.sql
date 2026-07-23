-- =====================================================================
-- 0007 — Phase 5: commission tiers
-- =====================================================================
-- Additive only: three rows in `commission_tiers` and nothing else. No
-- column, constraint, policy or response shape changes.
--
-- Why a migration rather than a seed, for the same reason as the Phase 4
-- baseline model version: ZM-FEE-011 computes the platform commission from
-- the *active tier*, so a database with migrations applied and no dev seed
-- would be unable to price an offer at all. This is platform configuration,
-- not demonstration data — it sits beside `platform_settings`, which
-- migration 0001 populates in exactly the same way.
--
-- The tiers themselves are an assumption, not a requirement: the frozen pack
-- fixes the mechanism (percentage-of-gross from a versioned tier, payer
-- configurable) and leaves the numbers to the operator. They are recorded
-- here so the demo has defensible figures and so nobody has to invent them
-- at a keyboard during a rehearsal. Changing them is an INSERT of new rows
-- with a later `effective_from`, never an UPDATE — the same create-never-edit
-- discipline as the risk model versions, and for the same reason: a
-- historical `commission_calculations` row cites its tier, and editing the
-- tier in place would silently redefine what was charged.
-- =====================================================================

BEGIN;

-- `effective_from` is set well in the past rather than to now(), so that a
-- demo running with the time machine wound backwards (ZM-DEMO-003) still
-- finds an active tier. A tier that begins "now" is invisible to any clock
-- the demo moves behind it.
-- `commission_tiers` has no unique constraint, so `ON CONFLICT DO NOTHING`
-- would be inert here — it only suppresses unique and exclusion violations,
-- and a second run would happily insert a duplicate set, leaving the tier
-- lookup ambiguous about which row priced a transaction. The guard has to be
-- an explicit existence check instead.
INSERT INTO commission_tiers
  (min_transaction_amount, max_transaction_amount, commission_percentage,
   fixed_commission_amount, fee_payer, effective_from, is_active)
SELECT v.min_amount, v.max_amount, v.pct, 0.000, 'SUPPLIER',
       TIMESTAMPTZ '2020-01-01 00:00:00+03', true
FROM (VALUES
  -- Small tickets carry the highest rate: the platform's per-transaction
  -- cost is largely fixed, so a flat percentage would under-recover here.
  (0.000::numeric,      10000.000::numeric,  1.50000::numeric),
  (10000.000,           50000.000,           1.25000),
  -- Open-ended top tier: max_transaction_amount IS NULL means "no ceiling",
  -- so there is no invoice size the tier lookup cannot price.
  (50000.000,           NULL,                1.00000)
) AS v(min_amount, max_amount, pct)
WHERE NOT EXISTS (SELECT 1 FROM commission_tiers WHERE is_active);

COMMIT;

-- =====================================================================
-- Verification
-- =====================================================================
--   SELECT min_transaction_amount, max_transaction_amount, commission_percentage
--     FROM commission_tiers WHERE is_active ORDER BY min_transaction_amount;
--   -- three rows, contiguous, the last with a NULL ceiling
--
-- Boundaries are half-open [min, max): 10000.000 falls in the SECOND tier,
-- not the first. The service's lookup and its tests both state this.
-- =====================================================================
