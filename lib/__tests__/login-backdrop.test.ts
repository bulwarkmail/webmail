import { describe, expect, it } from 'vitest';
import {
  loginBackdropAttributes,
  loginBackdropCss,
  resolveLoginBackdrop,
  usableBackgroundUrl,
} from '@/lib/login-backdrop';

const from = (values: Record<string, string>) => (key: string) => values[key] ?? '';

describe('resolveLoginBackdrop', () => {
  it('is the centered layout with no picture when nothing is set', () => {
    expect(resolveLoginBackdrop(from({}))).toEqual({ layout: 'centered', lightUrl: '', darkUrl: '', dim: 0, blur: 0 });
  });

  it('uses the light picture in dark mode when there is no dark one', () => {
    const b = resolveLoginBackdrop(from({ loginBackgroundLightUrl: '/api/admin/branding/bg.jpg?v=2' }));
    expect(b.darkUrl).toBe('/api/admin/branding/bg.jpg?v=2');
  });

  it('keeps dim and blur in range and ignores what is not a number', () => {
    expect(resolveLoginBackdrop(from({ loginBackgroundDim: '95', loginBackgroundBlur: '100' }))).toMatchObject({ dim: 80, blur: 24 });
    expect(resolveLoginBackdrop(from({ loginBackgroundDim: '-5', loginBackgroundBlur: 'lots' }))).toMatchObject({ dim: 0, blur: 0 });
    expect(resolveLoginBackdrop(from({ loginBackgroundDim: '35', loginBackgroundBlur: '6' }))).toMatchObject({ dim: 35, blur: 6 });
  });

  it('only knows the split layout besides centered', () => {
    expect(resolveLoginBackdrop(from({ loginLayout: 'split' })).layout).toBe('split');
    expect(resolveLoginBackdrop(from({ loginLayout: 'sideways' })).layout).toBe('centered');
  });
});

describe('usableBackgroundUrl', () => {
  it.each([
    ['/branding/bg.webp', '/branding/bg.webp'],
    ['https://cdn.example.com/bg.jpg', 'https://cdn.example.com/bg.jpg'],
    ['javascript:alert(1)', ''],
    ['data:image/svg+xml,<svg/>', ''],
    ['//evil.example/bg.jpg', ''],
    ['bg.jpg', ''],
  ])('%s -> %s', (input, expected) => {
    expect(usableBackgroundUrl(input)).toBe(expected);
  });
});

describe('loginBackdropCss', () => {
  it('is empty without a picture, whatever dim and blur say', () => {
    expect(loginBackdropCss(resolveLoginBackdrop(from({ loginBackgroundDim: '40' })))).toBe('');
  });

  it('sets the picture, dim and blur, and a separate dark-mode picture', () => {
    const css = loginBackdropCss(
      resolveLoginBackdrop(from({
        loginBackgroundLightUrl: '/api/admin/branding/light.jpg',
        loginBackgroundDarkUrl: 'https://cdn.example.com/dark.jpg',
        loginBackgroundDim: '40',
        loginBackgroundBlur: '8',
      })),
      (path) => `/webmail${path}`,
    );
    expect(css).toBe(
      ':root{--login-bg-image:url("/webmail/api/admin/branding/light.jpg");--login-bg-dim:0.4;--login-bg-blur:8px}'
      + ':root.dark{--login-bg-image:url("https://cdn.example.com/dark.jpg")}',
    );
  });

  it('cannot be closed early by the URL, neither the string, the rule nor the <style> element', () => {
    const css = loginBackdropCss(resolveLoginBackdrop(from({
      loginBackgroundLightUrl: 'https://x.example/a.jpg");}body{display:none}</style><script>alert(1)</script>',
    })));
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('<');
    // One url() whose string only ends where the declaration does.
    expect(css.match(/url\("[^"]*"\)/g)).toHaveLength(1);
    expect(css).toMatch(/^:root\{--login-bg-image:url\("https:\/\/x\.example\/a\.jpg%22%29;}body{display:none}%3C\/style%3E%3Cscript%3Ealert%281%29%3C\/script%3E"\);--login-bg-dim:0;--login-bg-blur:0px\}$/);
  });
});

describe('loginBackdropAttributes', () => {
  it('marks the split layout and a picture on <html>, and nothing by default', () => {
    expect(loginBackdropAttributes(resolveLoginBackdrop(from({})))).toEqual({});
    expect(loginBackdropAttributes(resolveLoginBackdrop(from({ loginLayout: 'split', loginBackgroundLightUrl: '/bg.jpg' })))).toEqual({
      'data-login-layout': 'split',
      'data-login-bg': 'image',
    });
  });
});
