import { useSettingsStore } from '@/stores/settings-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileSmartFolder } from '../smart-folder-query';
import { isSmartFolder, validSmartFolders } from '../smart-folder-schema';
import { systemViewFilter } from '../mail-view-filter';
import { buildCrossFilter } from '../unified-mailbox';
import type { SmartFolder } from '../smart-folder-types';

const folder: SmartFolder = { id: 'invoices', name: 'Invoices', enabled: true, order: 0,
  scope: 'active-account', match: 'all', conditions: [{ field: 'hasAttachment', value: true }] };

const originalZone = useSettingsStore.getState().timeZone;
beforeEach(() => useSettingsStore.setState({ timeZone: 'UTC' }));
afterEach(() => useSettingsStore.setState({ timeZone: originalZone }));

describe('smart folder query compiler', () => {
  it.each([['all', 'AND'], ['any', 'OR'], ['not', 'NOT']] as const)('compiles %s without extra semantics', (match, operator) => {
    expect(compileSmartFolder({ ...folder, match, conditions: [
      { field: 'from', value: 'family@example.org' }, { field: 'subject', value: 'Rechnung' },
      { field: 'hasAttachment', value: false }, { field: 'after', value: '2026-11-01' }, { field: 'before', value: '2026-11-12' },
    ] })).toEqual({ operator, conditions: [
      { from: 'family@example.org' }, { subject: 'Rechnung' }, { hasAttachment: false },
      { after: '2026-11-01T00:00:00.000Z' }, { before: '2026-11-12T00:00:00.000Z' },
    ] });
  });
  it.each([
    ['UTC', '2026-11-01', '2026-11-01T00:00:00.000Z'],
    ['Asia/Kolkata', '2026-11-01', '2026-10-31T18:30:00.000Z'],
    ['America/New_York', '2026-01-15', '2026-01-15T05:00:00.000Z'],
    // Local midnight on each side of the spring DST transition.
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z'],
    ['America/New_York', '2026-03-09', '2026-03-09T04:00:00.000Z'],
  ])('uses the effective %s timezone for %s', (timeZone, value, instant) => {
    useSettingsStore.setState({ timeZone });
    expect(compileSmartFolder({ ...folder, conditions: [{ field: 'after', value }, { field: 'before', value }] }))
      .toEqual({ operator: 'AND', conditions: [{ after: instant }, { before: instant }] });
  });

  it.each([
    { conditions: [] }, { conditions: [{ field: 'script', value: 'alert(1)' }] },
    { conditions: [{ field: 'subject', value: 'x', operator: 'OR' }] },
    { conditions: [{ field: 'hasAttachment', value: 'true' }] },
    { conditions: [{ field: 'after', value: '2026-02-30' }] },
    { conditions: [{ field: 'before', value: 'yesterday' }] },
    { conditions: [{ field: 'from', value: ' ' }] },
    { scope: 'all-accounts' }, { match: 'eval' }, { name: '' }, { order: -1 },
    { filter: { inMailbox: 'secret' } }, { conditions: Array(21).fill({ field: 'subject', value: 'x' }) },
  ])('rejects malformed/unsupported definition %j', (patch) => {
    const invalid = { ...folder, ...patch } as SmartFolder;
    expect(isSmartFolder(invalid)).toBe(false);
    expect(() => compileSmartFolder(invalid)).toThrow('Invalid smart folder');
  });
  it('rejects unknown versions, duplicate IDs, oversized sets and accessors', () => {
    expect(validSmartFolders([folder], 2)).toBe(false);
    expect(validSmartFolders([folder, folder])).toBe(false);
    expect(validSmartFolders(Array.from({ length: 51 }, (_, i) => ({ ...folder, id: String(i) })))).toBe(false);
    const getter = { ...folder }; const read = vi.fn(() => 'x');
    Object.defineProperty(getter, 'name', { enumerable: true, get: read });
    expect(isSmartFolder(getter)).toBe(false); expect(read).not.toHaveBeenCalled();
  });
  it('keeps built-in keyword filters and their aggregation constraint unchanged', () => {
    expect(systemViewFilter('unread')).toEqual({ notKeyword: '$seen' });
    expect(systemViewFilter('starred')).toEqual({ hasKeyword: '$flagged' });
    expect(buildCrossFilter('unread', ['inbox'])).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { notKeyword: '$seen' }] });
    expect(buildCrossFilter('starred', ['inbox'])).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { hasKeyword: '$flagged' }] });
  });
});
