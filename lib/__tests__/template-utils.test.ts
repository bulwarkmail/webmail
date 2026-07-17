import { describe, it, expect } from 'vitest';
import {
  extractPlaceholders,
  substitutePlaceholders,
  hasUnresolvedPlaceholders,
  validateTemplateName,
  getAutoFilledPlaceholders,
  getPlaceholdersFromTemplate,
  isBuiltInPlaceholder,
  filterTemplates,
  exportTemplates,
  importTemplates,
  spliceTemplateAboveSignature,
} from '../template-utils';
import type { EmailTemplate } from '../template-types';

function makeTemplate(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: 'test-id',
    name: 'Test Template',
    subject: '',
    body: '',
    isHTML: false,
    category: '',
    isFavorite: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('extractPlaceholders', () => {
  it('extracts single placeholder', () => {
    expect(extractPlaceholders('Hello {{name}}')).toEqual(['name']);
  });

  it('extracts multiple placeholders', () => {
    const result = extractPlaceholders('{{greeting}} {{name}}, welcome to {{company}}');
    expect(result).toEqual(['greeting', 'name', 'company']);
  });

  it('deduplicates repeated placeholders', () => {
    expect(extractPlaceholders('{{name}} and {{name}}')).toEqual(['name']);
  });

  it('returns empty array for no placeholders', () => {
    expect(extractPlaceholders('No placeholders here')).toEqual([]);
  });

  it('handles empty string', () => {
    expect(extractPlaceholders('')).toEqual([]);
  });

  it('ignores malformed placeholders', () => {
    expect(extractPlaceholders('{{}} {name} {{ name }}')).toEqual([]);
  });

  it('handles underscored names', () => {
    expect(extractPlaceholders('{{first_name}} {{last_name}}')).toEqual(['first_name', 'last_name']);
  });
});

describe('substitutePlaceholders', () => {
  it('replaces a single placeholder', () => {
    expect(substitutePlaceholders('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice');
  });

  it('replaces multiple placeholders', () => {
    const result = substitutePlaceholders('{{greeting}} {{name}}', {
      greeting: 'Hi',
      name: 'Bob',
    });
    expect(result).toBe('Hi Bob');
  });

  it('leaves unresolved placeholders', () => {
    expect(substitutePlaceholders('{{known}} {{unknown}}', { known: 'yes' })).toBe('yes {{unknown}}');
  });

  it('sanitizes XSS in values', () => {
    const result = substitutePlaceholders('{{name}}', { name: '<script>alert(1)</script>' });
    expect(result).not.toContain('<script>');
  });

  it('handles empty values', () => {
    expect(substitutePlaceholders('{{name}}', { name: '' })).toBe('');
  });

  it('handles no placeholders in text', () => {
    expect(substitutePlaceholders('No placeholders', { name: 'test' })).toBe('No placeholders');
  });
});

describe('hasUnresolvedPlaceholders', () => {
  it('returns true when placeholders exist', () => {
    expect(hasUnresolvedPlaceholders('Hello {{name}}')).toBe(true);
  });

  it('returns false when no placeholders', () => {
    expect(hasUnresolvedPlaceholders('Hello world')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasUnresolvedPlaceholders('')).toBe(false);
  });

  it('returns consistent results on consecutive calls', () => {
    const text = 'Hello {{name}}';
    expect(hasUnresolvedPlaceholders(text)).toBe(true);
    expect(hasUnresolvedPlaceholders(text)).toBe(true);
    expect(hasUnresolvedPlaceholders(text)).toBe(true);
  });
});

describe('validateTemplateName', () => {
  it('returns null for valid name', () => {
    expect(validateTemplateName('My Template')).toBeNull();
  });

  it('returns empty for empty string', () => {
    expect(validateTemplateName('')).toBe('empty');
  });

  it('returns empty for whitespace only', () => {
    expect(validateTemplateName('   ')).toBe('empty');
  });

  it('returns too_long for name over 200 chars', () => {
    expect(validateTemplateName('a'.repeat(201))).toBe('too_long');
  });

  it('accepts name at exactly 200 chars', () => {
    expect(validateTemplateName('a'.repeat(200))).toBeNull();
  });
});

describe('getAutoFilledPlaceholders', () => {
  it('includes date and day_of_week', () => {
    const result = getAutoFilledPlaceholders({});
    expect(result).toHaveProperty('date');
    expect(result).toHaveProperty('day_of_week');
  });

  it('includes sender_name when provided', () => {
    const result = getAutoFilledPlaceholders({ senderName: 'John' });
    expect(result.sender_name).toBe('John');
  });

  it('omits sender_name when not provided', () => {
    const result = getAutoFilledPlaceholders({});
    expect(result).not.toHaveProperty('sender_name');
  });
});

describe('getPlaceholdersFromTemplate', () => {
  it('extracts from both subject and body', () => {
    const tpl = makeTemplate({
      subject: 'Hello {{name}}',
      body: 'Welcome to {{company}}',
    });
    expect(getPlaceholdersFromTemplate(tpl)).toEqual(['name', 'company']);
  });

  it('deduplicates across subject and body', () => {
    const tpl = makeTemplate({
      subject: '{{name}}',
      body: '{{name}} again',
    });
    expect(getPlaceholdersFromTemplate(tpl)).toEqual(['name']);
  });
});

describe('isBuiltInPlaceholder', () => {
  it('returns true for built-in names', () => {
    expect(isBuiltInPlaceholder('date')).toBe(true);
    expect(isBuiltInPlaceholder('sender_name')).toBe(true);
    expect(isBuiltInPlaceholder('recipient_name')).toBe(true);
    expect(isBuiltInPlaceholder('company')).toBe(true);
    expect(isBuiltInPlaceholder('day_of_week')).toBe(true);
  });

  it('returns false for custom names', () => {
    expect(isBuiltInPlaceholder('custom_field')).toBe(false);
    expect(isBuiltInPlaceholder('project')).toBe(false);
  });
});

describe('exportTemplates', () => {
  it('produces valid JSON with metadata', () => {
    const templates = [makeTemplate()];
    const json = exportTemplates(templates);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.type).toBe('webmail-templates');
    expect(parsed.templates).toHaveLength(1);
    expect(parsed.exportedAt).toBeDefined();
  });

  it('handles empty array', () => {
    const json = exportTemplates([]);
    const parsed = JSON.parse(json);
    expect(parsed.templates).toHaveLength(0);
  });
});

describe('importTemplates', () => {
  it('imports valid export data', () => {
    const original = [makeTemplate({ name: 'Test' })];
    const json = exportTemplates(original);
    const result = importTemplates(json);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('Test');
    expect(result.errors).toHaveLength(0);
  });

  it('assigns new IDs on import', () => {
    const original = [makeTemplate({ name: 'Test' })];
    const json = exportTemplates(original);
    const result = importTemplates(json);
    expect(result.templates[0].id).not.toBe('test-id');
  });

  it('returns error for invalid JSON', () => {
    const result = importTemplates('not json');
    expect(result.templates).toHaveLength(0);
    expect(result.errors).toContain('invalid_json');
  });

  it('returns error for wrong type', () => {
    const result = importTemplates(JSON.stringify({ type: 'other', version: 1, templates: [] }));
    expect(result.errors).toContain('invalid_type');
  });

  it('returns error for unsupported version', () => {
    const result = importTemplates(JSON.stringify({ type: 'webmail-templates', version: 99, templates: [] }));
    expect(result.errors).toContain('unsupported_version');
  });

  it('returns error for non-object input', () => {
    const result = importTemplates('"just a string"');
    expect(result.errors).toContain('invalid_format');
  });

  it('skips entries without name', () => {
    const json = JSON.stringify({
      type: 'webmail-templates',
      version: 1,
      templates: [{ subject: 'no name' }, { name: 'Valid' }],
    });
    const result = importTemplates(json);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('Valid');
    expect(result.errors).toContain('missing_template_name');
  });

  it('sanitizes imported values against XSS', () => {
    const json = JSON.stringify({
      type: 'webmail-templates',
      version: 1,
      templates: [{ name: '<img onerror=alert(1) src=x>', subject: '<script>alert(1)</script>' }],
    });
    const result = importTemplates(json);
    expect(result.templates[0].name).not.toContain('onerror');
    expect(result.templates[0].subject).not.toContain('<script>');
  });

  it('handles missing templates array', () => {
    const result = importTemplates(JSON.stringify({ type: 'webmail-templates', version: 1 }));
    expect(result.errors).toContain('invalid_templates');
  });

  it('imports defaultRecipients correctly', () => {
    const json = JSON.stringify({
      type: 'webmail-templates',
      version: 1,
      templates: [{
        name: 'With Recipients',
        defaultRecipients: { to: ['a@b.com'], cc: ['c@d.com'] },
      }],
    });
    const result = importTemplates(json);
    expect(result.templates[0].defaultRecipients?.to).toEqual(['a@b.com']);
    expect(result.templates[0].defaultRecipients?.cc).toEqual(['c@d.com']);
  });

  it('round-trips export and import', () => {
    const originals = [
      makeTemplate({ name: 'Template 1', subject: 'Hi {{name}}', category: 'work', isFavorite: true }),
      makeTemplate({ name: 'Template 2', body: 'Body text', category: 'personal' }),
    ];
    const json = exportTemplates(originals);
    const result = importTemplates(json);
    expect(result.templates).toHaveLength(2);
    expect(result.templates[0].name).toBe('Template 1');
    expect(result.templates[0].subject).toBe('Hi {{name}}');
    expect(result.templates[1].name).toBe('Template 2');
    expect(result.errors).toHaveLength(0);
  });
});

describe('filterTemplates', () => {
  const templates = [
    makeTemplate({ id: '1', name: 'Follow-up', subject: 'Re: meeting', category: 'work' }),
    makeTemplate({ id: '2', name: 'Welcome', subject: 'Hello there', category: 'personal' }),
    makeTemplate({ id: '3', name: 'Invoice', subject: 'Monthly bill', category: 'work' }),
  ];

  it('filters by name', () => {
    const result = filterTemplates(templates, 'follow');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('filters by subject', () => {
    const result = filterTemplates(templates, 'meeting');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('filters by category', () => {
    const result = filterTemplates(templates, 'personal');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('is case-insensitive', () => {
    expect(filterTemplates(templates, 'WELCOME')).toHaveLength(1);
  });

  it('returns all when multiple match', () => {
    expect(filterTemplates(templates, 'work')).toHaveLength(2);
  });

  it('returns empty array for no matches', () => {
    expect(filterTemplates(templates, 'xyz')).toHaveLength(0);
  });
});

describe('spliceTemplateAboveSignature', () => {
  const template = '<p>Template body</p>';

  it('keeps the signature block below the template (separator marker)', () => {
    const prev = '<p></p><p data-signature-block="separator">-- </p><div>My signature</div><p data-signature-block="end"></p>';
    expect(spliceTemplateAboveSignature(prev, template)).toBe(
      '<p>Template body</p><p data-signature-block="separator">-- </p><div>My signature</div><p data-signature-block="end"></p>'
    );
  });

  it('keeps the signature block below the template (start marker, no separator)', () => {
    const prev = '<p>old draft text</p><p data-signature-block="start"></p><div>My signature</div><p data-signature-block="end"></p>';
    expect(spliceTemplateAboveSignature(prev, template)).toBe(
      '<p>Template body</p><p data-signature-block="start"></p><div>My signature</div><p data-signature-block="end"></p>'
    );
  });

  it('replaces the whole body when there is no signature block', () => {
    expect(spliceTemplateAboveSignature('<p>old draft text</p>', template)).toBe(template);
  });

  it('keeps everything from the start marker onward when the end marker is missing', () => {
    const prev = '<p>old</p><p data-signature-block="separator">-- </p><div>My signature</div>';
    expect(spliceTemplateAboveSignature(prev, template)).toBe(
      '<p>Template body</p><p data-signature-block="separator">-- </p><div>My signature</div>'
    );
  });

  it('discards user edits above the signature', () => {
    const prev = '<p>half-written draft</p><p data-signature-block="separator">-- </p><div>Sig</div><p data-signature-block="end"></p>';
    const result = spliceTemplateAboveSignature(prev, template);
    expect(result).not.toContain('half-written draft');
    expect(result).toContain('Sig');
  });
});
