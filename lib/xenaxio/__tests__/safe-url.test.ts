import { describe, expect, it } from 'vitest';
import { safeHttpUrl, safeNextPath } from '../brand';

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

describe('safeNextPath', () => {
  it('keeps paths on this site', () => {
    expect(safeNextPath('/de/connect/?client_id=a&state=b')).toBe('/de/connect/?client_id=a&state=b');
  });

  it('rejects other sites and tricks', () => {
    for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '', null, undefined]) {
      expect(safeNextPath(bad)).toBeNull();
    }
  });
});

