import { describe, expect, it } from 'vitest';
import { sanitizePolicyDefaults } from '../policy-defaults';

describe('sanitizePolicyDefaults (#1248)', () => {
  it('keeps plain values', () => {
    expect(sanitizePolicyDefaults({ showSharedMailAccounts: false, emailsPerPage: 25, deleteAction: 'trash' }))
      .toEqual({ showSharedMailAccounts: false, emailsPerPage: 25, deleteAction: 'trash' });
  });

  it('drops maps, null and numbers that are not finite', () => {
    expect(sanitizePolicyDefaults({ b: { c: 1 }, d: null, e: Number.NaN, f: Infinity })).toEqual({});
  });

  it('keeps short lists of strings for the client to check (#1564)', () => {
    expect(sanitizePolicyDefaults({ hoverActions: ['delete', 'spam'], empty: [] }))
      .toEqual({ hoverActions: ['delete', 'spam'], empty: [] });
  });

  it('drops lists of other things, and long ones', () => {
    expect(sanitizePolicyDefaults({
      a: [1],
      b: [{ c: 1 }],
      c: Array.from({ length: 51 }, () => 'x'),
      d: ['x'.repeat(101)],
    })).toEqual({});
  });

  it('drops prototype keys', () => {
    const out = sanitizePolicyDefaults(JSON.parse('{"__proto__": "x", "constructor": "y", "ok": true}'));
    expect(Object.keys(out)).toEqual(['ok']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('turns a missing or malformed section into an empty one', () => {
    expect(sanitizePolicyDefaults(undefined)).toEqual({});
    expect(sanitizePolicyDefaults(null)).toEqual({});
    expect(sanitizePolicyDefaults(['x'])).toEqual({});
    expect(sanitizePolicyDefaults('x')).toEqual({});
  });
});
