import { describe, expect, it } from 'vitest';
import {
  EMPTY_SHARED_TAGS,
  applySharedTagChanges,
  groupAccountTags,
  parseSharedTags,
  planSharedTagsSave,
  readSharedTags,
  sharedDefinitions,
} from '../shared-tags';
import { MetadataTooLargeError } from '../jmap/bulwark-metadata';

// Shared tag definitions of a group account, as they sit in the metadata of
// its Inbox: a map by tag id under `tags`, changed one tag at a time.

const MAP = {
  tags: {
    urgent: { label: 'Urgent', color: 'red' },
    other: { label: 'Other', color: 'chartreuse', icon: 'flame' },
  },
  note: 'kept',
};

describe('readSharedTags', () => {
  it('reads the map by id and keeps fields it doesn\'t know', () => {
    const stored = readSharedTags(MAP);
    expect(stored.patchable).toBe(true);
    expect(stored.entries.other).toEqual({ label: 'Other', color: 'chartreuse', icon: 'flame' });
    expect(stored.extra).toEqual({ note: 'kept' });
  });

  it('reads the earlier list and bare-array shapes, for converting', () => {
    const fromList = readSharedTags({ list: [{ id: 'urgent', label: 'Urgent', color: 'red' }, { id: 'URGENT', label: 'Twice' }] });
    expect(fromList).toEqual({ entries: { urgent: { label: 'Urgent', color: 'red' } }, extra: {}, patchable: false });
    expect(readSharedTags([{ id: 'later', label: 'Later', color: 'blue' }]).entries).toEqual({ later: { label: 'Later', color: 'blue' } });
  });

  it('drops what cannot be a tag', () => {
    const stored = readSharedTags({ tags: { 'has space': { label: 'x' }, 'ctl\u0001': { label: 'x' }, fine: 'not an object', ok: {} } });
    expect(Object.keys(stored.entries)).toEqual(['ok']);
    expect(readSharedTags(undefined)).toEqual(EMPTY_SHARED_TAGS);
  });
});

describe('sharedDefinitions', () => {
  it('names each tag, shows a color it doesn\'t know as grey, and sorts by name', () => {
    expect(sharedDefinitions(readSharedTags(MAP))).toEqual([
      { id: 'other', label: 'Other', color: 'gray' },
      { id: 'urgent', label: 'Urgent', color: 'red' },
    ]);
    expect(parseSharedTags({ tags: { x: { color: 'blue' } } })).toEqual([{ id: 'x', label: 'x', color: 'blue' }]);
  });

  it('keeps a #rrggbb color, lowercased, and shows other codes as grey', () => {
    expect(parseSharedTags({ tags: {
      a: { label: 'A', color: '#1a73e8' },
      b: { label: 'B', color: '#1A73E8' },
      c: { label: 'C', color: '#abc' },
      d: { label: 'D', color: 'red' },
      e: { label: 'E', color: 'not-a-key' },
    } }).map((tag) => tag.color)).toEqual(['#1a73e8', '#1a73e8', 'gray', 'red', 'gray']);
  });
});

describe('planSharedTagsSave', () => {
  it('patches only the tags that change', () => {
    const { patches, result } = planSharedTagsSave(readSharedTags(MAP), [
      { id: 'new/child', value: { label: 'Child', color: 'blue' } },
      { id: 'URGENT', value: null },
    ]);
    expect(patches).toEqual([
      { path: ['tags', 'new/child'], value: { label: 'Child', color: 'blue' } },
      { path: ['tags', 'urgent'], value: null },
    ]);
    expect(Object.keys(result.entries).sort()).toEqual(['new/child', 'other']);
  });

  it('keeps the fields of a changed tag it doesn\'t know, and its color unless one was picked', () => {
    const { patches } = planSharedTagsSave(readSharedTags(MAP), [{ id: 'other', value: { label: 'Renamed' } }]);
    expect(patches).toEqual([{ path: ['tags', 'other'], value: { label: 'Renamed', color: 'chartreuse', icon: 'flame' } }]);
  });

  it('writes a hex color as given and keeps it through a rename', () => {
    const picked = applySharedTagChanges(readSharedTags(MAP), [{ id: 'urgent', value: { label: 'Urgent', color: '#1a73e8' } }]);
    expect(picked.entries.urgent).toEqual({ label: 'Urgent', color: '#1a73e8' });
    const renamed = applySharedTagChanges(picked, [{ id: 'urgent', value: { label: 'Now' } }]);
    expect(renamed.entries.urgent).toEqual({ label: 'Now', color: '#1a73e8' });
  });

  it('writes an earlier shape once, whole, as the map', () => {
    const { patches, result } = planSharedTagsSave(
      readSharedTags({ list: [{ id: 'urgent', label: 'Urgent', color: 'red' }] }),
      [{ id: 'later', value: { label: 'Later', color: 'blue' } }],
    );
    expect(patches).toEqual([{ path: [], value: { tags: { urgent: { label: 'Urgent', color: 'red' }, later: { label: 'Later', color: 'blue' } } } }]);
    expect(result.patchable).toBe(true);
  });

  it('refuses more than 8 KB of UTF-8, counted in bytes not characters', () => {
    // 100 names of 30 two-byte characters: about 4.9 K characters, over 8 K bytes.
    const changes = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, value: { label: 'ä'.repeat(30), color: 'red' } }));
    const json = JSON.stringify({ tags: Object.fromEntries(changes.map((c) => [c.id, c.value])) });
    expect(json.length).toBeLessThan(8192);
    expect(() => planSharedTagsSave(EMPTY_SHARED_TAGS, changes)).toThrow(MetadataTooLargeError);
    expect(() => planSharedTagsSave(EMPTY_SHARED_TAGS, changes.slice(0, 50))).not.toThrow();
  });
});

describe('groupAccountTags', () => {
  it('lists the shared definitions, then every tag on the messages nobody named', () => {
    const { definitions, discoveredIds } = groupAccountTags(
      [{ id: 'urgent', label: 'Urgent', color: 'red' }],
      { '$label:urgent': 4, '$label:q3-invoices': 2 },
      false,
    );
    expect(definitions.map((t) => t.id)).toEqual(['urgent', 'q3-invoices']);
    expect(definitions[1].label).toBe('Q3 Invoices');
    expect(discoveredIds).toEqual(['q3-invoices']);
  });

  it('names a tag by its shared definition whatever case the message uses', () => {
    const { definitions } = groupAccountTags([{ id: 'urgent', label: 'Urgent', color: 'red' }], { '$label:Urgent': 1 }, false);
    expect(definitions).toHaveLength(1);
  });
});
