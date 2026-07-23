-- =====================================================================
-- 0008 — Phase 6: locked_at immutability, contract templates, AS-01
-- =====================================================================
-- Additive only. One trigger, one settings row, four template rows. No
-- column, constraint, policy or response shape is altered.
--
-- Three things live here:
--
--   1. The INV-4 trigger. The frozen schema names the invariant in a comment
--      ("A transaction may be locked exactly once") and leaves it to be
--      implemented "as triggers or service-layer guards". The service guard
--      exists in AcceptanceService. This is the other half, and the half
--      that holds when the service is not in the path.
--
--   2. The AS-01 acceptance-role setting, so "configurable" means
--      configurable rather than a sentence in a requirements document.
--
--   3. The contract templates (ZM-CON-002/003). A migration rather than a
--      seed for the same reason as the commission tiers in 0007 and the
--      baseline risk model in 0006: contract generation reads the active
--      template, so a migrated database with no dev seed could not generate
--      a contract at all. This is platform configuration, not demo data.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. INV-4 — a transaction locks exactly once
-- ---------------------------------------------------------------------
-- The service checks `locked_at IS NULL` under a row lock, which is what
-- makes concurrent acceptance safe. This trigger is what makes the invariant
-- true regardless of who is writing: a direct SQL session, a future job, a
-- migration written in a hurry, or a bug in the service.
--
-- It refuses two distinct things:
--   * changing a non-null locked_at to a different value (re-locking)
--   * clearing a non-null locked_at back to NULL (unlocking)
--
-- The second is the one worth spelling out. "Unlock and re-accept" is exactly
-- the operation someone will reach for when a deal needs unwinding, and it
-- must not exist: acceptance is irreversible by design, and an unwind is a
-- withdrawal case (Phase 8) that leaves the original record standing.
--
-- `locked_by_offer_id` is bound to the same rule. A lock that points at a
-- different offer than the one that took it is the same defect wearing a
-- different column.

CREATE OR REPLACE FUNCTION enforce_transaction_lock_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
      RAISE EXCEPTION
        'INV-4: locked_at is immutable once set (transaction %). Acceptance is irreversible; '
        'unwinding an accepted offer is a withdrawal case, not an update.',
        OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW.locked_by_offer_id IS DISTINCT FROM OLD.locked_by_offer_id THEN
      RAISE EXCEPTION
        'INV-4: locked_by_offer_id is immutable once the transaction is locked (transaction %).',
        OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transaction_lock_immutable ON receivable_transactions;
CREATE TRIGGER trg_transaction_lock_immutable
  BEFORE UPDATE ON receivable_transactions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_transaction_lock_immutable();

-- ---------------------------------------------------------------------
-- 2. AS-01 — who may accept an offer
-- ---------------------------------------------------------------------
-- Default: Supplier Owner and Signatory. The assumption records that this is
-- "configurable to allow Invoice Uploader", so it is a setting rather than a
-- constant. Adding 'SUPPLIER_UPLOADER' to this array is the whole change —
-- the route guard already admits it and the service reads this row.

INSERT INTO platform_settings (key, value, description)
SELECT 'offer_acceptance_roles',
       '["SUPPLIER_OWNER","SUPPLIER_SIGNATORY"]'::jsonb,
       'AS-01: roles permitted to accept an offer. Add SUPPLIER_UPLOADER to widen.'
WHERE NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'offer_acceptance_roles');

-- ---------------------------------------------------------------------
-- 3. Contract templates (ZM-CON-001..003)
-- ---------------------------------------------------------------------
-- One template per transaction type plus a default fallback, in both
-- languages, versioned. `transaction_type IS NULL` is the fallback row that
-- ZM-CON-002 requires; the selection query prefers an exact match and falls
-- back to it, so a transaction type with no dedicated template still
-- contracts rather than failing.
--
-- Only the fallback and the two types the demo actually uses are seeded
-- here. RECEIVABLE_ASSIGNMENT and OTHER fall through to the default, which is
-- the fallback doing its job rather than a gap.
--
-- ZM-I18N-003b: English is canonical. The Arabic templates exist so an
-- Arabic-speaking signatory can read what they are signing; the English text
-- governs, and both templates say so in their own language.
--
-- Merge fields are `{{dotted.names}}` resolved against a flat map built from
-- the accepted-offer snapshot and verified party data. The engine has no
-- conditionals and no loops on purpose — see template-engine.ts. An
-- unresolved field is a hard error, never a blank, so adding a field to a
-- template without adding it to the map fails generation loudly.

INSERT INTO contract_templates (transaction_type, language, version, body_template, is_active)
SELECT v.transaction_type::transaction_type, v.language::language_code, v.version,
       v.body_template, true
FROM (VALUES
  (NULL, 'EN', 'v1.0', $tpl$<article class="contract" lang="en">
  <header>
    <h1>Receivable Financing Agreement</h1>
    <p class="reference">Contract {{contract.number}} &middot; {{contract.generatedAt}}</p>
  </header>

  <section>
    <h2>1. Parties</h2>
    <p><strong>The Supplier:</strong> {{supplier.legalName}}, national establishment number
      {{supplier.establishmentNumber}}, commercial registration {{supplier.registrationNumber}}.</p>
    <p><strong>The Bank:</strong> {{bank.legalName}}, licence number {{bank.licenceNumber}}.</p>
    <p>Zimmamless is not a party to this Agreement. It operates the platform through which the
      Supplier and the Bank reached these terms and records their execution.</p>
  </section>

  <section>
    <h2>2. The Receivable</h2>
    <p>Invoice {{invoice.number}}, issued {{invoice.issueDate}} and due {{invoice.dueDate}},
      owed by {{buyer.legalName}} (national establishment number {{buyer.establishmentNumber}}),
      with a face value of {{invoice.faceValue}} {{invoice.currency}} and an outstanding amount of
      {{invoice.outstandingAmount}} {{invoice.currency}}.</p>
  </section>

  <section>
    <h2>3. Structure</h2>
    <p>This Agreement is entered into as a <strong>{{terms.transactionType}}</strong> on a
      <strong>{{terms.recourseType}}</strong> basis.</p>
  </section>

  <section>
    <h2>4. Consideration</h2>
    <table class="terms">
      <tr><th>Gross funding amount</th><td>{{terms.grossFundingAmount}} JOD</td></tr>
      <tr><th>Less: bank discount</th><td>{{terms.bankDiscountAmount}} JOD</td></tr>
      <tr><th>Less: bank fees</th><td>{{terms.bankFeesAmount}} JOD</td></tr>
      <tr><th>Less: platform commission</th><td>{{terms.platformCommissionAmount}} JOD</td></tr>
      <tr><th>Less: listing fee</th><td>{{terms.listingFeeAmount}} JOD</td></tr>
      <tr><th>Less: other deductions</th><td>{{terms.otherDeductionsAmount}} JOD</td></tr>
      <tr class="net"><th>Net payable to the Supplier</th><td>{{terms.netSupplierPayout}} JOD</td></tr>
    </table>
  </section>

  <section>
    <h2>5. Conditions</h2>
    {{contract.conditionsHtml}}
  </section>

  <section>
    <h2>6. Prior rights and perfection</h2>
    <p>Zimmamless performs a platform-internal control against the same receivable being financed
      twice through the platform. That control is not a search of any register, does not
      constitute a prior-rights check, and does not effect or evidence any legal perfection of
      the Bank&rsquo;s interest. Those remain entirely the Bank&rsquo;s responsibility.</p>
  </section>

  <section>
    <h2>7. Governing text</h2>
    <p>The English text of this Agreement is the canonical version. Where a translation is
      provided for convenience and differs from the English, the English text governs.</p>
  </section>

  <footer>
    <p class="integrity">Accepted-offer snapshot {{snapshot.hash}}, captured {{snapshot.capturedAt}}.</p>
  </footer>
</article>$tpl$),

  ('INVOICE_FINANCING', 'EN', 'v1.0', $tpl$<article class="contract" lang="en">
  <header>
    <h1>Invoice Financing Agreement</h1>
    <p class="reference">Contract {{contract.number}} &middot; {{contract.generatedAt}}</p>
  </header>

  <section>
    <h2>1. Parties</h2>
    <p><strong>The Supplier:</strong> {{supplier.legalName}}, national establishment number
      {{supplier.establishmentNumber}}, commercial registration {{supplier.registrationNumber}}.</p>
    <p><strong>The Bank:</strong> {{bank.legalName}}, licence number {{bank.licenceNumber}}.</p>
    <p>Zimmamless is not a party to this Agreement.</p>
  </section>

  <section>
    <h2>2. Advance against the receivable</h2>
    <p>The Bank advances funds to the Supplier against invoice {{invoice.number}}, issued
      {{invoice.issueDate}} and due {{invoice.dueDate}}, owed by {{buyer.legalName}}
      (national establishment number {{buyer.establishmentNumber}}). The receivable remains the
      Supplier&rsquo;s; the Bank takes a financing interest in its proceeds.</p>
    <p>Face value {{invoice.faceValue}} {{invoice.currency}}; outstanding
      {{invoice.outstandingAmount}} {{invoice.currency}}.</p>
  </section>

  <section>
    <h2>3. Recourse</h2>
    <p>This financing is provided on a <strong>{{terms.recourseType}}</strong> basis. The
      Supplier should read this clause together with clause 5: recourse determines who bears the
      loss if the Buyer does not pay.</p>
  </section>

  <section>
    <h2>4. Consideration</h2>
    <table class="terms">
      <tr><th>Gross funding amount</th><td>{{terms.grossFundingAmount}} JOD</td></tr>
      <tr><th>Less: bank discount</th><td>{{terms.bankDiscountAmount}} JOD</td></tr>
      <tr><th>Less: bank fees</th><td>{{terms.bankFeesAmount}} JOD</td></tr>
      <tr><th>Less: platform commission</th><td>{{terms.platformCommissionAmount}} JOD</td></tr>
      <tr><th>Less: listing fee</th><td>{{terms.listingFeeAmount}} JOD</td></tr>
      <tr><th>Less: other deductions</th><td>{{terms.otherDeductionsAmount}} JOD</td></tr>
      <tr class="net"><th>Net payable to the Supplier</th><td>{{terms.netSupplierPayout}} JOD</td></tr>
    </table>
  </section>

  <section>
    <h2>5. Conditions</h2>
    {{contract.conditionsHtml}}
  </section>

  <section>
    <h2>6. Prior rights and perfection</h2>
    <p>Zimmamless performs a platform-internal control against the same receivable being financed
      twice through the platform. That control is not a search of any register and does not
      effect or evidence legal perfection of the Bank&rsquo;s interest.</p>
  </section>

  <section>
    <h2>7. Governing text</h2>
    <p>The English text of this Agreement is the canonical version.</p>
  </section>

  <footer>
    <p class="integrity">Accepted-offer snapshot {{snapshot.hash}}, captured {{snapshot.capturedAt}}.</p>
  </footer>
</article>$tpl$),

  ('RECEIVABLE_PURCHASE', 'EN', 'v1.0', $tpl$<article class="contract" lang="en">
  <header>
    <h1>Receivable Purchase Agreement</h1>
    <p class="reference">Contract {{contract.number}} &middot; {{contract.generatedAt}}</p>
  </header>

  <section>
    <h2>1. Parties</h2>
    <p><strong>The Seller:</strong> {{supplier.legalName}}, national establishment number
      {{supplier.establishmentNumber}}, commercial registration {{supplier.registrationNumber}}.</p>
    <p><strong>The Purchaser:</strong> {{bank.legalName}}, licence number {{bank.licenceNumber}}.</p>
    <p>Zimmamless is not a party to this Agreement.</p>
  </section>

  <section>
    <h2>2. Sale of the receivable</h2>
    <p>The Seller sells and the Purchaser buys the receivable evidenced by invoice
      {{invoice.number}}, issued {{invoice.issueDate}} and due {{invoice.dueDate}}, owed by
      {{buyer.legalName}} (national establishment number {{buyer.establishmentNumber}}), with a
      face value of {{invoice.faceValue}} {{invoice.currency}} and an outstanding amount of
      {{invoice.outstandingAmount}} {{invoice.currency}}.</p>
    <p>Title passes to the Purchaser on payment of the net consideration in clause 4.</p>
  </section>

  <section>
    <h2>3. Recourse</h2>
    <p>This purchase is made on a <strong>{{terms.recourseType}}</strong> basis.</p>
  </section>

  <section>
    <h2>4. Consideration</h2>
    <table class="terms">
      <tr><th>Gross purchase price</th><td>{{terms.grossFundingAmount}} JOD</td></tr>
      <tr><th>Less: purchaser discount</th><td>{{terms.bankDiscountAmount}} JOD</td></tr>
      <tr><th>Less: purchaser fees</th><td>{{terms.bankFeesAmount}} JOD</td></tr>
      <tr><th>Less: platform commission</th><td>{{terms.platformCommissionAmount}} JOD</td></tr>
      <tr><th>Less: listing fee</th><td>{{terms.listingFeeAmount}} JOD</td></tr>
      <tr><th>Less: other deductions</th><td>{{terms.otherDeductionsAmount}} JOD</td></tr>
      <tr class="net"><th>Net payable to the Seller</th><td>{{terms.netSupplierPayout}} JOD</td></tr>
    </table>
  </section>

  <section>
    <h2>5. Conditions</h2>
    {{contract.conditionsHtml}}
  </section>

  <section>
    <h2>6. Prior rights and perfection</h2>
    <p>Zimmamless performs a platform-internal control against the same receivable being financed
      twice through the platform. That control is not a search of any register and does not
      effect or evidence legal perfection of the Purchaser&rsquo;s title.</p>
  </section>

  <section>
    <h2>7. Governing text</h2>
    <p>The English text of this Agreement is the canonical version.</p>
  </section>

  <footer>
    <p class="integrity">Accepted-offer snapshot {{snapshot.hash}}, captured {{snapshot.capturedAt}}.</p>
  </footer>
</article>$tpl$),

  (NULL, 'AR', 'v1.0', $tpl$<article class="contract" lang="ar" dir="rtl">
  <header>
    <h1>اتفاقية تمويل ذمم مدينة</h1>
    <p class="reference">العقد {{contract.number}} &middot; {{contract.generatedAt}}</p>
  </header>

  <section>
    <h2>١. الأطراف</h2>
    <p><strong>المورّد:</strong> {{supplier.legalName}}، الرقم الوطني للمنشأة
      {{supplier.establishmentNumber}}، السجل التجاري {{supplier.registrationNumber}}.</p>
    <p><strong>البنك:</strong> {{bank.legalName}}، رقم الترخيص {{bank.licenceNumber}}.</p>
    <p>منصة زمّاملس ليست طرفاً في هذه الاتفاقية.</p>
  </section>

  <section>
    <h2>٢. الذمة المدينة</h2>
    <p>الفاتورة {{invoice.number}}، الصادرة بتاريخ {{invoice.issueDate}} والمستحقة بتاريخ
      {{invoice.dueDate}}، والمستحقة على {{buyer.legalName}} (الرقم الوطني للمنشأة
      {{buyer.establishmentNumber}})، بقيمة اسمية {{invoice.faceValue}} {{invoice.currency}}
      ورصيد قائم {{invoice.outstandingAmount}} {{invoice.currency}}.</p>
  </section>

  <section>
    <h2>٣. طبيعة المعاملة</h2>
    <p>تُبرم هذه الاتفاقية بصفة <strong>{{terms.transactionType}}</strong> وعلى أساس
      <strong>{{terms.recourseType}}</strong>.</p>
  </section>

  <section>
    <h2>٤. المقابل</h2>
    <table class="terms">
      <tr><th>إجمالي مبلغ التمويل</th><td>{{terms.grossFundingAmount}} دينار</td></tr>
      <tr><th>يُخصم: خصم البنك</th><td>{{terms.bankDiscountAmount}} دينار</td></tr>
      <tr><th>يُخصم: رسوم البنك</th><td>{{terms.bankFeesAmount}} دينار</td></tr>
      <tr><th>يُخصم: عمولة المنصة</th><td>{{terms.platformCommissionAmount}} دينار</td></tr>
      <tr><th>يُخصم: رسوم الإدراج</th><td>{{terms.listingFeeAmount}} دينار</td></tr>
      <tr><th>يُخصم: خصومات أخرى</th><td>{{terms.otherDeductionsAmount}} دينار</td></tr>
      <tr class="net"><th>الصافي المستحق للمورّد</th><td>{{terms.netSupplierPayout}} دينار</td></tr>
    </table>
  </section>

  <section>
    <h2>٥. الشروط</h2>
    {{contract.conditionsHtml}}
  </section>

  <section>
    <h2>٦. الحقوق السابقة والإتمام القانوني</h2>
    <p>تُجري زمّاملس ضابطاً داخلياً على مستوى المنصة يمنع تمويل الذمة المدينة ذاتها مرتين عبر
      المنصة. هذا الضابط ليس بحثاً في أي سجل، ولا يشكّل تحقّقاً من الحقوق السابقة، ولا يُنشئ أو
      يُثبت أي إتمام قانوني لحق البنك. ويبقى ذلك بكامله من مسؤولية البنك.</p>
  </section>

  <section>
    <h2>٧. النص الحاكم</h2>
    <p>النص الإنجليزي لهذه الاتفاقية هو النسخة المعتمدة. وحيثما اختلفت هذه الترجمة، المقدَّمة
      لغايات التيسير، عن النص الإنجليزي، فإن النص الإنجليزي هو الحاكم.</p>
  </section>

  <footer>
    <p class="integrity">بصمة عرض القبول {{snapshot.hash}}، بتاريخ {{snapshot.capturedAt}}.</p>
  </footer>
</article>$tpl$)
) AS v(transaction_type, language, version, body_template)
WHERE NOT EXISTS (
  SELECT 1 FROM contract_templates WHERE version = 'v1.0'
);

COMMIT;

-- =====================================================================
-- Verification
-- =====================================================================
--   SELECT transaction_type, language, version FROM contract_templates
--    WHERE is_active ORDER BY language, transaction_type NULLS FIRST;
--   -- 4 rows: EN fallback, EN invoice financing, EN receivable purchase,
--   --         AR fallback
--
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_transaction_lock_immutable';
--   -- 1 row
--
-- INV-4 by hand, on a locked transaction:
--   UPDATE receivable_transactions SET locked_at = NULL WHERE locked_at IS NOT NULL;
--   -- ERROR: INV-4: locked_at is immutable once set
-- =====================================================================
