import { languageFor, latestVersion, render } from './template-render';

describe('template rendering', () => {
  it('substitutes a placeholder', () => {
    expect(render('Invoice {{invoiceNumber}} is due.', { invoiceNumber: 'INV-42' }).text).toBe(
      'Invoice INV-42 is due.',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(render('Hello {{ name }}.', { name: 'Layla' }).text).toBe('Hello Layla.');
  });

  it('renders a missing variable as empty, never as visible machinery', () => {
    // A missing variable is a template bug. Showing a real person
    // "{{buyerName}}" in a message is a second, worse bug on top of it.
    const result = render('Buyer: {{buyerName}}.', {});
    expect(result.text).toBe('Buyer: .');
    expect(result.text).not.toContain('{{');
    expect(result.missing).toEqual(['buyerName']);
  });

  it('reports each missing name once', () => {
    const result = render('{{a}} {{a}} {{b}}', {});
    expect(result.missing).toEqual(['a', 'b']);
  });

  it('treats null as missing but zero as a real value', () => {
    // "0 days remaining" is a sentence that must render.
    expect(render('{{days}} left', { days: 0 }).text).toBe('0 left');
    expect(render('{{days}} left', { days: null }).missing).toEqual(['days']);
  });

  it('does not evaluate anything — it is substitution, not a language', () => {
    // A template rich enough to compute is rich enough to leak a field nobody
    // meant to show.
    const result = render('{{a}} {{constructor}} {{__proto__}}', { a: 'x' });
    // `{{constructor}}` used to render "function Object() { [native code] }".
    expect(result.text).toBe('x  ');
    expect(result.text).not.toContain('native code');
  });

  it('leaves a non-placeholder brace alone', () => {
    expect(render('Amount { 500 } JOD', {}).text).toBe('Amount { 500 } JOD');
  });

  it('passes money through as the string it was given', () => {
    // Money is a 3-dp string everywhere; a template must not reformat it.
    expect(render('{{amount}} JOD', { amount: '8390.000' }).text).toBe('8390.000 JOD');
  });
});

describe('language selection (ZM-I18N-003)', () => {
  it('honours the recipient’s own preference', () => {
    expect(languageFor('AR')).toBe('AR');
    expect(languageFor('EN')).toBe('EN');
  });

  it('falls back to the platform default, never to a guess', () => {
    // No locale detection from a browser header: the platform asks people what
    // language they want and remembers the answer.
    expect(languageFor(null)).toBe('EN');
    expect(languageFor(undefined)).toBe('EN');
    expect(languageFor('fr-FR')).toBe('EN');
    expect(languageFor(null, 'AR')).toBe('AR');
  });
});

describe('template version selection', () => {
  it('picks the highest version', () => {
    expect(latestVersion(['1.0', '1.1', '1.2'])).toBe('1.2');
  });

  it('sorts numerically, so 10 beats 9', () => {
    // Lexically "1.10" < "1.9", which would silently pin a template at an old
    // version once it reached double digits.
    expect(latestVersion(['1.9', '1.10'])).toBe('1.10');
    expect(latestVersion(['2.0', '10.0'])).toBe('10.0');
  });

  it('handles differing segment counts', () => {
    expect(latestVersion(['1', '1.0.1'])).toBe('1.0.1');
  });

  it('returns null when there is nothing to pick', () => {
    expect(latestVersion([])).toBeNull();
  });
});
