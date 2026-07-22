-- =====================================================================
-- MIGRATION 0004 — business_calendar_holidays read policy
-- =====================================================================
-- Fixes a real gap in migration 0003: that migration enabled RLS on
-- business_calendar_holidays (line 183) but never wrote a policy for it.
-- RLS with no policy is deny-all, so the table was invisible to every
-- direct-SQL caller.
--
-- Caught by `npm run db:verify`, whose coverage check fails when any table
-- has RLS enabled without a policy. Worth noting how quietly this would
-- otherwise have failed: the API reads holidays through the service role,
-- which bypasses RLS, so the SLA business-day arithmetic in Phase 2 would
-- have worked in every test while the table stayed unreadable to anything
-- else — surfacing much later as an SLA clock that disagreed with the
-- database depending on who asked.
--
-- Shipped as a new migration rather than an edit to 0003 because 0003 is
-- already applied to the hosted project; the runner's checksum drift check
-- would (correctly) refuse an in-place edit.
--
-- Jordanian public holidays are reference data, not tenant data: every
-- authenticated user may read them, nobody may write them through direct
-- SQL. Same treatment as contract_templates and notification_templates.
-- =====================================================================

CREATE POLICY holidays_read ON business_calendar_holidays
  FOR SELECT TO authenticated
  USING (true);

GRANT SELECT ON business_calendar_holidays TO authenticated;
