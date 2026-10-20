import { describe, expect, it } from 'vitest';
import de from '@/locales/de/common.json';
import en from '@/locales/en/common.json';
import { rebrandMessages } from '../brand';

function strings(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree];
  if (tree && typeof tree === 'object') return Object.values(tree).flatMap(strings);
  return [];
}

describe('rebrandMessages', () => {
  it('replaces the upstream product name in every German and English string', () => {
    for (const catalog of [de, en]) {
      const out = strings(rebrandMessages(catalog as Record<string, unknown>));
      expect(out.filter((s) => s.includes('Bulwark'))).toEqual([]);
      expect(out.length).toBe(strings(catalog).length);
    }
  });

  it('keeps sentences readable', () => {
    expect(rebrandMessages({ a: 'Willkommen bei Bulwark Mail', b: { c: 'Bulwark Webmail' }, n: 3 })).toEqual({
      a: 'Willkommen bei xenaxio',
      b: { c: 'xenaxio' },
      n: 3,
    });
  });
});
