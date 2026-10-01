import { describe, it, expect } from 'vitest';
import {
  findUnrecognizedKeywords,
  suggestKeywordColor,
  suggestKeywordLabel,
  tagIdFromKeyword,
} from '../keyword-discovery';
import { KEYWORD_PALETTE, type KeywordDefinition } from '@/stores/settings-store';

const defined = (...ids: string[]): KeywordDefinition[] =>
  ids.map((id) => ({ id, label: id, color: 'gray' }));

describe('tagIdFromKeyword', () => {
  it('reads the current prefix', () => {
    expect(tagIdFromKeyword('$label:work')).toBe('work');
  });

  it('reads the legacy prefix', () => {
    expect(tagIdFromKeyword('$color:work')).toBe('work');
  });

  it('keeps nesting separators in the id', () => {
    expect(tagIdFromKeyword('$label:work/clients/acme')).toBe('work/clients/acme');
  });

  it('rejects system keywords', () => {
    expect(tagIdFromKeyword('$seen')).toBeNull();
    expect(tagIdFromKeyword('$flagged')).toBeNull();
    expect(tagIdFromKeyword('nonsense')).toBeNull();
  });

  it('rejects a bare prefix with no id', () => {
    expect(tagIdFromKeyword('$label:')).toBeNull();
  });
});

describe('suggestKeywordLabel', () => {
  it('turns separators into words and capitalises them', () => {
    expect(suggestKeywordLabel('q3-invoices', false)).toBe('Q3 Invoices');
    expect(suggestKeywordLabel('to_do', false)).toBe('To Do');
  });

  it('names only the innermost level when nesting is on', () => {
    expect(suggestKeywordLabel('work/clients/acme-corp', true)).toBe('Acme Corp');
  });

  it('names the whole id when nesting is off, since it is one opaque token', () => {
    expect(suggestKeywordLabel('work/clients/acme-corp', false)).toBe('Work/Clients/Acme Corp');
  });

  it('falls back to the id when there is nothing to humanise', () => {
    expect(suggestKeywordLabel('/', true)).toBe('/');
  });
});

describe('suggestKeywordColor', () => {
  it('keeps the colour of a tag named after one', () => {
    expect(suggestKeywordColor('blue')).toBe('blue');
    expect(suggestKeywordColor('work/red-dark')).toBe('red-dark');
  });

  it('always proposes a real palette key', () => {
    for (const id of ['q3-invoices', 'a', 'zzz', 'работа', 'x'.repeat(200)]) {
      expect(suggestKeywordColor(id)).toBeTypeOf('string');
      expect(KEYWORD_PALETTE[suggestKeywordColor(id)]).toBeDefined();
    }
  });

  it('is stable for the same id', () => {
    expect(suggestKeywordColor('q3-invoices')).toBe(suggestKeywordColor('q3-invoices'));
  });

  it('avoids colours already in use', () => {
    const first = suggestKeywordColor('q3-invoices');
    expect(suggestKeywordColor('q3-invoices', [first])).not.toBe(first);
  });

  it('still yields a colour when every hue is taken', () => {
    const everything = Object.keys(KEYWORD_PALETTE);
    expect(KEYWORD_PALETTE[suggestKeywordColor('q3-invoices', everything)]).toBeDefined();
  });
});

describe('findUnrecognizedKeywords', () => {
  it('reports only tag keywords with no definition', () => {
    const found = findUnrecognizedKeywords(
      { $seen: 12, $flagged: 3, '$label:work': 5, '$label:q3-invoices': 2 },
      defined('work'),
      false,
    );
    expect(found.map((entry) => entry.id)).toEqual(['q3-invoices']);
  });

  it('proposes a name and the keyword as stored', () => {
    const [entry] = findUnrecognizedKeywords({ '$label:q3-invoices': 2 }, [], false);
    expect(entry).toMatchObject({
      id: 'q3-invoices',
      keyword: '$label:q3-invoices',
      label: 'Q3 Invoices',
      count: 2,
    });
  });

  it('finds tags still written under the legacy prefix', () => {
    const found = findUnrecognizedKeywords({ '$color:receipts': 4 }, [], false);
    expect(found.map((entry) => entry.id)).toEqual(['receipts']);
  });

  it('treats both prefixes as one tag and adds their counts up', () => {
    const found = findUnrecognizedKeywords(
      { '$label:receipts': 4, '$color:receipts': 3 },
      [],
      false,
    );
    expect(found).toHaveLength(1);
    expect(found[0].count).toBe(7);
  });

  it('matches definitions case-insensitively', () => {
    expect(findUnrecognizedKeywords({ '$label:Work': 5 }, defined('work'), false)).toEqual([]);
  });

  it('folds spellings that differ only in case into one entry', () => {
    const found = findUnrecognizedKeywords({ '$label:Work': 5, '$label:work': 2 }, [], false);
    expect(found).toHaveLength(1);
    expect(found[0].count).toBe(7);
  });

  it('orders by how much mail carries the tag, then by id', () => {
    const found = findUnrecognizedKeywords(
      { '$label:rare': 1, '$label:common': 90, '$label:also-rare': 1 },
      [],
      false,
    );
    expect(found.map((entry) => entry.id)).toEqual(['common', 'also-rare', 'rare']);
  });

  it('proposes a distinct colour per tag so a bulk import stays legible', () => {
    const found = findUnrecognizedKeywords(
      { '$label:one': 5, '$label:two': 4, '$label:three': 3, '$label:four': 2 },
      [],
      false,
    );
    expect(new Set(found.map((entry) => entry.color)).size).toBe(found.length);
  });

  it('avoids colours existing tags already wear', () => {
    const existing: KeywordDefinition[] = [{ id: 'work', label: 'Work', color: 'teal' }];
    const found = findUnrecognizedKeywords(
      { '$label:one': 5, '$label:two': 4, '$label:three': 3 },
      existing,
      false,
    );
    expect(found.map((entry) => entry.color)).not.toContain('teal');
  });

  it('recovers a tag named after a colour in that colour, taken or not', () => {
    const existing: KeywordDefinition[] = [{ id: 'work', label: 'Work', color: 'blue' }];
    const found = findUnrecognizedKeywords({ '$label:blue': 5 }, existing, false);
    expect(found[0].color).toBe('blue');
  });

  it('returns nothing when the account carries no tags at all', () => {
    expect(findUnrecognizedKeywords({ $seen: 40, $draft: 2 }, defined('work'), false)).toEqual([]);
  });

  it('proposes ids that keep pointing at the same messages', () => {
    const [entry] = findUnrecognizedKeywords({ '$label:work/clients/acme': 3 }, [], true);
    expect(entry.id).toBe('work/clients/acme');
    expect(entry.label).toBe('Acme');
  });

  it('prefers what the server calls a tag over what its id looks like', () => {
    const [entry] = findUnrecognizedKeywords(
      { '$label:societa-agricola': 12 },
      [],
      false,
      [{ id: '$label:societa-agricola', name: 'Società Agricola', color: '#42d692' }],
    );
    expect(entry.label).toBe('Società Agricola');
    // #42d692 is a green of ordinary lightness: the palette entry nearest it,
    // not a hashed hue.
    expect(entry.color).toBe('green');
  });

  it('offers a described tag the scan never met, and keeps it last', () => {
    const found = findUnrecognizedKeywords({ '$label:seen': 9 }, [], false, [
      { id: '$label:unused', name: 'Unused', color: null },
    ]);
    expect(found.map((entry) => entry.id)).toEqual(['seen', 'unused']);
    expect(found[1].count).toBe(0);
  });

  it('leaves a described tag alone once it has a definition', () => {
    expect(
      findUnrecognizedKeywords({}, defined('work'), false, [
        { id: '$label:work', name: 'Work', color: '#ff0000' },
      ]),
    ).toEqual([]);
  });

  it('falls back to its own suggestion when the server keeps no colour', () => {
    const [entry] = findUnrecognizedKeywords({ '$label:q3': 4 }, [], false, [
      { id: '$label:q3', name: 'Q3', color: null },
    ]);
    expect(entry.label).toBe('Q3');
    expect(entry.color).toBeTruthy();
  });
});
