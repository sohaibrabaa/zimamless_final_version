import {
  UnresolvedMergeFields,
  escapeHtml,
  fieldsUsedBy,
  render,
  renderConditions,
} from './template-engine';

describe('merge-field resolution', () => {
  it('substitutes dotted field names', () => {
    expect(render('Hello {{supplier.legalName}}.', { 'supplier.legalName': 'Al-Noor' })).toBe(
      'Hello Al-Noor.',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(render('{{  a.b  }}', { 'a.b': 'x' })).toBe('x');
  });

  it('substitutes every occurrence of a repeated field', () => {
    expect(render('{{a}} and {{a}}', { a: 'x' })).toBe('x and x');
  });
});

describe('an unresolved field is an error, never a blank', () => {
  it('throws rather than rendering an empty string', () => {
    // "The Supplier,  , hereby assigns" is worse than a failed generation:
    // it looks finished.
    expect(() => render('The Supplier, {{supplier.legalName}}, assigns.', {})).toThrow(
      UnresolvedMergeFields,
    );
  });

  it('names every missing field at once, sorted', () => {
    try {
      render('{{b}} {{a}} {{c}}', { b: 'present' });
      fail('expected a throw');
    } catch (err) {
      expect((err as UnresolvedMergeFields).fields).toEqual(['a', 'c']);
    }
  });

  it('treats an explicit null as missing', () => {
    expect(() => render('{{a}}', { a: null as unknown as string })).toThrow(UnresolvedMergeFields);
  });

  it('accepts an empty string as a real value', () => {
    // Different from missing: a field deliberately set to '' is a decision.
    expect(render('[{{a}}]', { a: '' })).toBe('[]');
  });
});

describe('escaping', () => {
  it('escapes the five characters that can alter document structure', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes merged values, so a legal name cannot inject markup', () => {
    const output = render('<p>{{supplier.legalName}}</p>', {
      'supplier.legalName': 'Acme <script>alert(1)</script> & Co',
    });
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('&amp; Co');
  });

  it('does NOT escape the one pre-rendered field, which this module produced', () => {
    const html = renderConditions([{ title: 'A', description: null, isMandatory: true }], 'EN');
    const output = render('{{contract.conditionsHtml}}', { 'contract.conditionsHtml': html });
    expect(output).toContain('<ol class="conditions">');
  });
});

describe('fieldsUsedBy', () => {
  it('lists a template’s fields once each, sorted', () => {
    expect(fieldsUsedBy('{{b}} {{a}} {{b}}')).toEqual(['a', 'b']);
  });
});

describe('rendered conditions', () => {
  it('states mandatory or not in words, not by styling', () => {
    // A supplier signing a document should not have to infer from a bullet’s
    // appearance that a condition is binding.
    const html = renderConditions(
      [
        { title: 'Assignment notice', description: 'Countersigned.', isMandatory: true },
        { title: 'Quarterly statements', description: null, isMandatory: false },
      ],
      'EN',
    );
    expect(html).toContain('Assignment notice');
    expect(html).toContain('(Mandatory)');
    expect(html).toContain('(Not mandatory)');
    expect(html).toContain('Countersigned.');
  });

  it('escapes condition text, which the bank supplied', () => {
    const html = renderConditions(
      [{ title: '<img src=x onerror=1>', description: null, isMandatory: true }],
      'EN',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('says so explicitly when there are none', () => {
    expect(renderConditions([], 'EN')).toContain('No additional conditions');
    expect(renderConditions([], 'AR')).toContain('لا توجد شروط');
  });

  it('labels in Arabic for an Arabic document', () => {
    const html = renderConditions([{ title: 'ضمان', description: null, isMandatory: true }], 'AR');
    expect(html).toContain('إلزامي');
  });
});

describe('the engine has no control flow, deliberately', () => {
  it('does not interpret anything but a merge field', () => {
    // A contract is a legal document whose text is agreed in advance. A
    // template that can branch is a template nobody has fully read.
    const template = '{{#if x}}hidden{{/if}} {{a}}';
    const output = render(template, { a: 'value' });
    expect(output).toBe('{{#if x}}hidden{{/if}} value');
  });
});
