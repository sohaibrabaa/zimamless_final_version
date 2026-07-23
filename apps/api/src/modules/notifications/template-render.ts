/**
 * Template rendering for notifications (ZM-NOT-004, ZM-I18N-*).
 *
 * A deliberately small substitution engine: `{{variable}}` and nothing else.
 * No conditionals, no loops, no expression evaluation. A notification template
 * is edited by operations staff and rendered with data from a live
 * transaction; a template language rich enough to compute is a template
 * language rich enough to leak a field nobody meant to show, or to fail at
 * render time on a transaction that happens to be shaped differently.
 *
 * Everything this needs to express, it can: a name, an amount, a date, an
 * invoice number.
 */

export type TemplateVariables = Record<string, string | number | null | undefined>;

// A leading underscore is allowed deliberately: `{{__proto__}}` must be
// *recognised* as a placeholder so it renders as empty, rather than being
// unmatched and left visible in a message. Recognising it is what makes the
// own-property check below the thing that neutralises it.
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitutes `{{name}}` from `variables`.
 *
 * An unknown placeholder renders as an empty string rather than leaving
 * `{{buyerName}}` visible in a message sent to a real person. A missing
 * variable is a template bug; showing the reader the machinery is a second,
 * worse bug on top of it. `missing` collects the names so the caller can log
 * them without failing the send.
 */
export function render(
  template: string,
  variables: TemplateVariables,
): { text: string; missing: string[] } {
  const missing: string[] = [];

  const text = template.replace(PLACEHOLDER, (_match, name: string) => {
    // Own properties only. A plain lookup resolves up the prototype chain, so
    // `{{constructor}}` in a template rendered "function Object() { [native
    // code] }" into a message sent to a real person. Found by the test below
    // rather than by a recipient.
    const has = Object.prototype.hasOwnProperty.call(variables, name);
    const value = has ? variables[name] : undefined;
    if (value === undefined || value === null) {
      missing.push(name);
      return '';
    }
    return String(value);
  });

  return { text, missing: [...new Set(missing)] };
}

/**
 * Which language to render in.
 *
 * The recipient's own preference wins; `default_language` (EN, per
 * ZM-I18N-003) is the fallback. There is deliberately no locale detection from
 * a browser header — the platform asks people what language they want and
 * remembers the answer, rather than guessing from a device setting that often
 * describes the device rather than the person.
 */
export function languageFor(
  recipientLanguage: string | null | undefined,
  defaultLanguage: 'EN' | 'AR' = 'EN',
): 'EN' | 'AR' {
  return recipientLanguage === 'AR' || recipientLanguage === 'EN'
    ? recipientLanguage
    : defaultLanguage;
}

/**
 * Picks the active template version.
 *
 * Versions are strings like `1.0`, `1.1`. Sorted numerically segment by
 * segment rather than lexically, because `"10"` sorts before `"9"` as text and
 * that would silently pin a template at an old version once it reached double
 * digits.
 */
export function latestVersion(versions: readonly string[]): string | null {
  if (versions.length === 0) return null;
  return [...versions].sort(compareVersions).at(-1) ?? null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) return a.localeCompare(b);
    if (l !== r) return l - r;
  }
  return 0;
}
