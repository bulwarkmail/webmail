import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from '../brand';

describe('safeHttpUrl', () => {
  it('keeps absolute http(s) links from config.json', () => {
    expect(safeHttpUrl('https://xenaxio.com')).toBe('https://xenaxio.com/');
    expect(safeHttpUrl('https://xenaxio.com/impressum/')).toBe('https://xenaxio.com/impressum/');
  });

  it('drops empty, relative and script links', () => {
    expect(safeHttpUrl('')).toBe('');
    expect(safeHttpUrl(undefined)).toBe('');
    expect(safeHttpUrl('/impressum')).toBe('');
    expect(safeHttpUrl('javascript:alert(1)')).toBe('');
    expect(safeHttpUrl('data:text/html,hi')).toBe('');
  });
});
