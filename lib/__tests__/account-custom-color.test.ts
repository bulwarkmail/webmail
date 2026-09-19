import { describe, expect, it } from 'vitest';
import { accountTintKey } from '../account-utils';

describe('account row colors', () => {
  it('matches custom hues instead of making every custom account gray', () => {
    expect(accountTintKey('#ff0000')).toBe('red-dark');
    expect(accountTintKey('#0077ee')).toBe('blue-dark');
    expect(accountTintKey('#00bb99')).toBe('teal-dark');
    expect(accountTintKey('#cc44cc')).toBe('purple-dark');
  });
  it('preserves existing colors and handles neutral or invalid choices', () => {
    expect(accountTintKey('#7c3aed')).toBe('purple');
    expect(accountTintKey('#666666')).toBe('gray-dark');
    expect(accountTintKey(undefined)).toBe('gray-dark');
    expect(accountTintKey('red')).toBe('gray-dark');
  });
});
