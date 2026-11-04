import { describe, expect, it } from 'vitest';
import { applyPatchObject, patchPath, patchedProperties } from '../jmap/patch-object';

describe('patch-object', () => {
  it('escapes path segments as JSON Pointer does', () => {
    expect(patchPath('relatedTo', '<a/b~c@x>')).toBe('relatedTo/<a~1b~0c@x>');
  });

  it('applies plain keys and member paths without touching the target', () => {
    const target = { title: 'T', alerts: { a: { acknowledged: null, action: 'display' }, b: { acknowledged: null } } };
    const after = applyPatchObject(target, { title: 'U', 'alerts/a/acknowledged': '2026-05-04T07:00:00Z', 'alerts/b': null, 'links/x~1y': { href: 'h' } });
    expect(after).toEqual({
      title: 'U',
      alerts: { a: { acknowledged: '2026-05-04T07:00:00Z', action: 'display' } },
      links: { 'x/y': { href: 'h' } },
    });
    expect(target.alerts.b).toEqual({ acknowledged: null });
  });

  it('keeps __proto__ as a plain key', () => {
    const after = applyPatchObject({ alerts: {} }, { 'alerts/__proto__': { polluted: true } }) as { alerts: object };
    expect(Object.getPrototypeOf(after.alerts)).toBe(Object.prototype);
    expect(Object.keys(after.alerts)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('shows a path patch as whole properties', () => {
    expect(patchedProperties({ alerts: { a: { x: 1 }, b: { x: 2 } } }, { 'alerts/a/x': 3 })).toEqual({ alerts: { a: { x: 3 }, b: { x: 2 } } });
  });
});
