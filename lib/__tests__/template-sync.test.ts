import { describe, it, expect } from 'vitest';
import {
  mergeSyncedTemplates,
  parseSyncedTemplates,
  parseTemplateTombstones,
  TEMPLATE_TOMBSTONE_TTL_MS,
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

// Inside the 90-day tombstone TTL of the 2026-02-01 tombstones used below.
const NOW = new Date('2026-03-01T00:00:00Z');

describe('parseSyncedTemplates', () => {
  it('returns null for a blob without a templates array (pre-sync build)', () => {
    expect(parseSyncedTemplates(undefined)).toBeNull();
    expect(parseSyncedTemplates({ not: 'an array' })).toBeNull();
  });

  it('preserves ids and timestamps of valid entries', () => {
    const result = parseSyncedTemplates([makeTemplate({ id: 'abc' })]);
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe('abc');
    expect(result![0].updatedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('drops entries without an id or name, and duplicate ids', () => {
    const result = parseSyncedTemplates([
      makeTemplate({ id: 'a' }),
      makeTemplate({ id: 'a', name: 'Duplicate' }),
      { ...makeTemplate(), id: undefined },
      makeTemplate({ id: 'b', name: '   ' }),
      'not an object',
    ]);
    expect(result!.map((t) => t.id)).toEqual(['a']);
  });

  it('strips markup from non-HTML fields', () => {
    const result = parseSyncedTemplates([
      makeTemplate({ id: 'a', name: '<b>Bold</b> name', body: '<p>hi</p>' }),
    ]);
    expect(result![0].name).toBe('Bold name');
    expect(result![0].body).toBe('hi');
  });
});

describe('parseTemplateTombstones', () => {
  it('returns an empty map for non-record values', () => {
    expect(parseTemplateTombstones(undefined)).toEqual({});
    expect(parseTemplateTombstones(['a'])).toEqual({});
  });

  it('drops entries whose value is not a parseable date', () => {
    expect(
      parseTemplateTombstones({ a: '2026-01-02T00:00:00Z', b: 'garbage', c: 42 })
    ).toEqual({ a: '2026-01-02T00:00:00Z' });
  });
});

describe('mergeSyncedTemplates', () => {
  it('adds templates only present in the incoming state', () => {
    const merged = mergeSyncedTemplates(
      { templates: [makeTemplate({ id: 'local' })], deletedTemplateIds: {} },
      { templates: [makeTemplate({ id: 'remote' })], deletedTemplateIds: {} },
      NOW
    );
    expect(merged.templates.map((t) => t.id).sort()).toEqual(['local', 'remote']);
  });

  it('keeps the newer copy per id, preferring local on ties', () => {
    const merged = mergeSyncedTemplates(
      {
        templates: [
          makeTemplate({ id: 'a', name: 'Local newer', updatedAt: '2026-02-01T00:00:00Z' }),
          makeTemplate({ id: 'b', name: 'Local tie' }),
        ],
        deletedTemplateIds: {},
      },
      {
        templates: [
          makeTemplate({ id: 'a', name: 'Remote older', updatedAt: '2026-01-15T00:00:00Z' }),
          makeTemplate({ id: 'b', name: 'Remote tie' }),
        ],
        deletedTemplateIds: {},
      },
      NOW
    );
    const byId = Object.fromEntries(merged.templates.map((t) => [t.id, t.name]));
    expect(byId).toEqual({ a: 'Local newer', b: 'Local tie' });
  });

  it('applies an incoming tombstone to a local template', () => {
    const merged = mergeSyncedTemplates(
      { templates: [makeTemplate({ id: 'a' })], deletedTemplateIds: {} },
      { templates: [], deletedTemplateIds: { a: '2026-02-01T00:00:00Z' } },
      NOW
    );
    expect(merged.templates).toEqual([]);
    expect(merged.deletedTemplateIds).toEqual({ a: '2026-02-01T00:00:00Z' });
  });

  it('resurrects a template edited after its deletion and clears the tombstone', () => {
    const merged = mergeSyncedTemplates(
      {
        templates: [makeTemplate({ id: 'a', updatedAt: '2026-03-01T00:00:00Z' })],
        deletedTemplateIds: {},
      },
      { templates: [], deletedTemplateIds: { a: '2026-02-01T00:00:00Z' } },
      NOW
    );
    expect(merged.templates.map((t) => t.id)).toEqual(['a']);
    expect(merged.deletedTemplateIds).toEqual({});
  });

  it('prunes tombstones older than the TTL', () => {
    const expired = new Date(NOW.getTime() - TEMPLATE_TOMBSTONE_TTL_MS - 1000).toISOString();
    const merged = mergeSyncedTemplates(
      { templates: [], deletedTemplateIds: { old: expired } },
      { templates: [], deletedTemplateIds: {} },
      NOW
    );
    expect(merged.deletedTemplateIds).toEqual({});
  });
});
