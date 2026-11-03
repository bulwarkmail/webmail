import { describe, expect, it } from 'vitest';
import { formatAuditDetail } from '../audit-format';

describe('formatAuditDetail', () => {
  it('names what a reverted setting was, not "undefined → undefined"', () => {
    expect(formatAuditDetail({ key: 'appName', oldValue: 'Webmail' })).toBe('appName: reverted from Webmail');
  });

  it('writes object values out, not [object Object]', () => {
    expect(formatAuditDetail({ key: 'domainBranding', old: [{ host: 'a' }], new: [] }))
      .toBe('domainBranding: [{"host":"a"}] → []');
  });

  it('lists the keys of a config update', () => {
    expect(formatAuditDetail({ changes: [{ key: 'a' }, { key: 'b' }] })).toBe('a, b');
  });

  it('marks text it cut off', () => {
    const line = formatAuditDetail({ id: 'x'.repeat(200) });
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBe(101);
  });

  it('is empty without a detail', () => {
    expect(formatAuditDetail({})).toBe('');
    expect(formatAuditDetail(undefined)).toBe('');
  });
});
