/**
 * The contract template engine (ZM-CON-001..003).
 *
 * Structured merge fields, `{{like.this}}`, resolved against a flat map built
 * from the accepted-offer snapshot and verified party data. Deliberately not
 * a general-purpose template language: no conditionals, no loops, no
 * expressions, no partials.
 *
 * That restraint is the design. A contract is a legal document whose text is
 * agreed in advance; a template that can branch is a template whose output
 * nobody has fully read. Everything variable about a Zimmamless contract is a
 * *value* — party names, amounts, dates, the condition list — and values are
 * what merge fields are for. The one repeating structure, the conditions, is
 * pre-rendered by the caller into a single field, so the template still says
 * exactly what it says.
 *
 * Two rules make the engine safe to hand a legal document:
 *
 *   1. **An unresolved field is an error, never an empty string.** A contract
 *      that reads "the Supplier,  , hereby assigns" is worse than a failed
 *      generation: it looks finished. `render` throws and names every missing
 *      field at once.
 *   2. **Values are HTML-escaped.** Documents are HTML per PA-09, and a
 *      company legal name containing `&` or `<` must not be able to alter the
 *      document's structure — nor a supplier-supplied condition title inject
 *      markup into a document the counterparty is about to sign.
 */

export class UnresolvedMergeFields extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`The template has unresolved merge fields: ${fields.join(', ')}`);
  }
}

const FIELD = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * Fields whose value is already markup produced by this module — the
 * conditions list being the only one. Kept as an explicit allow-list rather
 * than a `{{{triple}}}` syntax, so adding an unescaped field is a deliberate
 * edit to a named set and not a typo away.
 */
const PRE_RENDERED_FIELDS: ReadonlySet<string> = new Set(['contract.conditionsHtml']);

export type MergeFields = Readonly<Record<string, string>>;

export function render(template: string, fields: MergeFields): string {
  const missing = new Set<string>();

  const output = template.replace(FIELD, (_match, name: string) => {
    const value = fields[name];
    if (value === undefined || value === null) {
      missing.add(name);
      return '';
    }
    return PRE_RENDERED_FIELDS.has(name) ? value : escapeHtml(value);
  });

  if (missing.size > 0) throw new UnresolvedMergeFields([...missing].sort());
  return output;
}

/** Every field a template references, for validating a template on its own. */
export function fieldsUsedBy(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(FIELD)) found.add(match[1]);
  return [...found].sort();
}

/**
 * Renders the accepted conditions as a list.
 *
 * Produced here rather than in the template because it is the one part of the
 * document with a variable number of items, and because the mandatory/
 * optional distinction must be *stated in words* on the contract. A supplier
 * signing a document should not have to infer from a bullet's styling that a
 * condition is binding.
 */
export function renderConditions(
  conditions: readonly { title: string; description: string | null; isMandatory: boolean }[],
  language: 'EN' | 'AR',
): string {
  if (conditions.length === 0) {
    return language === 'AR'
      ? '<p>لا توجد شروط إضافية.</p>'
      : '<p>No additional conditions apply.</p>';
  }

  const mandatoryLabel = language === 'AR' ? 'إلزامي' : 'Mandatory';
  const optionalLabel = language === 'AR' ? 'غير إلزامي' : 'Not mandatory';

  const items = conditions
    .map((condition) => {
      const label = condition.isMandatory ? mandatoryLabel : optionalLabel;
      const description = condition.description
        ? `<br /><span class="condition-detail">${escapeHtml(condition.description)}</span>`
        : '';
      return (
        `<li><strong>${escapeHtml(condition.title)}</strong> ` +
        `<em>(${label})</em>${description}</li>`
      );
    })
    .join('\n      ');

  return `<ol class="conditions">\n      ${items}\n    </ol>`;
}
