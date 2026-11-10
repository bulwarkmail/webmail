import { describe, it, expect, vi } from 'vitest';
import {
  extractPlaceholders,
  substitutePlaceholders,
  hasUnresolvedPlaceholders,
  validateTemplateName,
  getAutoFilledPlaceholders,
  getPlaceholdersFromTemplate,
  getPlaceholderDefaults,
  isBuiltInPlaceholder,
  filterTemplates,
  exportTemplates,
  importTemplates,
  parseSyncedTemplates,
  spliceTemplateAboveSignature,
  composeBodyHasUserContent,
  embedTemplateImages,
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
  it('extracts the name of a placeholder with a default', () => {
    expect(extractPlaceholders('From {{time:15:00}} for {{guests:2}}, {{time}}')).toEqual(['time', 'guests']);
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

  it('escapes values going into an HTML template', () => {
    const result = substitutePlaceholders('<p>{{name}}</p>', { name: '<script>alert(1)</script>' }, { html: true });
    expect(result).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  // Values are text: an address in angle brackets or an ampersand is kept.
  it('keeps values as typed in a plain template', () => {
    expect(substitutePlaceholders('To {{name}}', { name: 'Smith & Co <j@x.com>' })).toBe('To Smith & Co <j@x.com>');
  });

  it('keeps the address in an HTML template visible', () => {
    expect(substitutePlaceholders('<p>{{name}}</p>', { name: 'Smith <j@x.com>' }, { html: true })).toBe('<p>Smith &lt;j@x.com&gt;</p>');
  });

  it('handles empty values', () => {
    expect(substitutePlaceholders('{{name}}', { name: '' })).toBe('');
  });

  it('handles no placeholders in text', () => {
    expect(substitutePlaceholders('No placeholders', { name: 'test' })).toBe('No placeholders');
  });
  it('replaces a placeholder with a default by the value', () => {
    expect(substitutePlaceholders('At {{time:15:00}}, again {{time}}', { time: '17:00' })).toBe('At 17:00, again 17:00');
  });

  it('leaves a placeholder with a default as it is without a value', () => {
    expect(substitutePlaceholders('At {{time:15:00}}', {})).toBe('At {{time:15:00}}');
  });
});

describe('hasUnresolvedPlaceholders', () => {
  it('returns true when placeholders exist', () => {
    expect(hasUnresolvedPlaceholders('Hello {{name}}')).toBe(true);
  });

  it('returns false when no placeholders', () => {
    expect(hasUnresolvedPlaceholders('Hello world')).toBe(false);
  });

  it('returns true for a placeholder with a default', () => {
    expect(hasUnresolvedPlaceholders('Hello {{name:Ada}}')).toBe(true);
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

  it('offers the date in numbers and as day, month and year (#1284)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 0));
    try {
      const de = getAutoFilledPlaceholders({ locale: 'de' });
      expect(de.short_date).toBe('05.10.2026');
      expect(de.day).toBe('05');
      expect(de.month).toBe('10');
      expect(de.year).toBe('2026');
      expect(getAutoFilledPlaceholders({ locale: 'en' }).short_date).toBe('10/05/2026');
    } finally {
      vi.useRealTimers();
    }
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

describe('getPlaceholderDefaults', () => {
  it('returns the first default of each placeholder, subject first', () => {
    const tpl = makeTemplate({
      subject: 'Stay from {{arrival:Sat 13 Feb}}',
      body: '{{greeting}}, see you {{arrival:Sun 14 Feb}} at {{time:15:00}} with {{guests}} {{guests:2}}',
    });
    expect(getPlaceholderDefaults(tpl)).toEqual(new Map([['arrival', 'Sat 13 Feb'], ['time', '15:00'], ['guests', '2']]));
  });

  it('decodes the default in an HTML body, not in a plain one', () => {
    expect(getPlaceholderDefaults(makeTemplate({ body: '<p>{{company:Smith &amp; Co}}</p>', isHTML: true })))
      .toEqual(new Map([['company', 'Smith & Co']]));
    expect(getPlaceholderDefaults(makeTemplate({ body: '{{company:Smith &amp; Co}}' })))
      .toEqual(new Map([['company', 'Smith &amp; Co']]));
  });

  it('takes no default across a tag or a line break', () => {
    expect(getPlaceholderDefaults(makeTemplate({ body: '<p>{{name:<b>Ada</b>}}</p>', isHTML: true }))).toEqual(new Map());
    expect(getPlaceholderDefaults(makeTemplate({ body: '{{name:Ada\nLovelace}}' }))).toEqual(new Map());
  });

  it('keeps an empty default', () => {
    expect(getPlaceholderDefaults(makeTemplate({ body: '{{reason:}} {{note}}' }))).toEqual(new Map([['reason', '']]));
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

  it('strips script and event handlers from an imported HTML body', () => {
    // The body reaches the composer's placeholder preview as markup in the
    // app document; it used to be kept exactly as the file had it.
    const json = JSON.stringify({
      type: 'webmail-templates',
      version: 1,
      templates: [{ name: 'Evil', isHTML: true, body: '<p>Hi {{name}}</p><img src=x onerror="alert(1)"><script>alert(2)</script>' }],
    });
    const body = importTemplates(json).templates[0].body;
    expect(body).toContain('Hi {{name}}');
    expect(body).not.toContain('onerror');
    expect(body).not.toContain('<script');
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

  // Name, subject, category and a plain body are text, shown as text: markup
  // in them is harmless and is kept as typed, not cut out or entity-encoded.
  it('keeps angle brackets and ampersands in plain-text fields', () => {
    const json = JSON.stringify({
      type: 'webmail-templates',
      version: 1,
      templates: [{
        name: 'Sales <EU>',
        subject: 'Re: {{recipient_name}} <{{recipient_email}}>',
        category: 'R&D',
        body: 'Please reply to <sales@example.com> if a<b & c',
        isHTML: false,
      }],
    });
    const [tpl] = importTemplates(json).templates;
    expect(tpl.name).toBe('Sales <EU>');
    expect(tpl.subject).toBe('Re: {{recipient_name}} <{{recipient_email}}>');
    expect(tpl.category).toBe('R&D');
    expect(tpl.body).toBe('Please reply to <sales@example.com> if a<b & c');
  });

  it('keeps plain-text fields of synced templates as typed', () => {
    const [tpl] = parseSyncedTemplates([
      { id: 't1', name: 'Sales', subject: 'a <= b', body: 'Write to <sales@example.com> & us', isHTML: false },
    ])!;
    expect(tpl.subject).toBe('a <= b');
    expect(tpl.body).toBe('Write to <sales@example.com> & us');
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

describe('composeBodyHasUserContent', () => {
  const signature = '<p data-signature-block="separator">-- </p><div>My signature</div><p data-signature-block="end"></p>';

  it('is false for a fresh compose body (empty paragraph + signature)', () => {
    expect(composeBodyHasUserContent(`<p></p>${signature}`)).toBe(false);
  });

  it('is false for an empty body', () => {
    expect(composeBodyHasUserContent('')).toBe(false);
    expect(composeBodyHasUserContent('<p></p>')).toBe(false);
  });

  it('is true once the user typed above the signature (#540)', () => {
    expect(composeBodyHasUserContent(`<p>Hello Mr.</p>${signature}`)).toBe(true);
  });

  it('is true for a body without a signature block', () => {
    expect(composeBodyHasUserContent('<p>Hello Mr.</p>')).toBe(true);
  });

  it('ignores signature text so a signature-only body stays untouched', () => {
    expect(composeBodyHasUserContent(`<p></p>${signature}`)).toBe(false);
    expect(composeBodyHasUserContent(`<p><br></p>${signature}`)).toBe(false);
  });

  it('counts text-free content such as a pasted image', () => {
    expect(composeBodyHasUserContent(`<p><img src="cid:1"></p>${signature}`)).toBe(true);
  });

  it('handles a signature range without an end marker', () => {
    const openEnded = '<p data-signature-block="start"></p><div>My signature</div>';
    expect(composeBodyHasUserContent(`<p></p>${openEnded}`)).toBe(false);
    expect(composeBodyHasUserContent(`<p>Hello Mr.</p>${openEnded}`)).toBe(true);
  });
});

describe('embedTemplateImages', () => {
  // A 1×1 PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const DATA = `data:image/png;base64,${PNG}`;
  const uploader = () => {
    let n = 0;
    return vi.fn(async (_file: File) => ({ cid: `img${++n}@webmail` }));
  };

  it('uploads a data: image and tags it with the cid', async () => {
    const upload = uploader();
    const html = await embedTemplateImages(`<p>Plan</p><p><img src="${DATA}" alt="Floor plan"></p>`, upload);
    expect(upload).toHaveBeenCalledTimes(1);
    const file = upload.mock.calls[0][0];
    expect(file).toMatchObject({ name: 'image-1.png', type: 'image/png' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
    const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img')!;
    expect(img.getAttribute('data-cid')).toBe('img1@webmail');
    expect(img.getAttribute('src')).toBe(DATA);
    expect(img.getAttribute('alt')).toBe('Floor plan');
  });

  it('uploads an image shown twice once', async () => {
    const upload = uploader();
    const html = await embedTemplateImages(`<img src="${DATA}"><img src="${DATA}">`, upload);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(html.match(/data-cid="img1@webmail"/g)).toHaveLength(2);
  });

  it('replaces a cid the template was saved with', async () => {
    const html = await embedTemplateImages(`<img src="${DATA}" data-cid="old@webmail">`, uploader());
    expect(html).toContain('data-cid="img1@webmail"');
    expect(html).not.toContain('old@webmail');
  });

  it('leaves remote, cid: and non-raster images alone', async () => {
    const upload = uploader();
    const html = '<img src="https://example.com/a.png"><img src="cid:a@b"><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">';
    expect(await embedTemplateImages(html, upload)).toBe(html);
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps an image as it is when its upload fails', async () => {
    const html = `<img src="${DATA}">`;
    expect(await embedTemplateImages(html, async () => null)).toBe(html);
  });
});
