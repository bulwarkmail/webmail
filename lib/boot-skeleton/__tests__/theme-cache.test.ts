import { beforeEach, describe, expect, it } from 'vitest';
import {
  bootSkinCSS,
  injectThemeCSS,
  injectThemeSkinCSS,
  removeThemeCSS,
  removeThemeSkinCSS,
} from '@/lib/theme-loader';
import { THEME_CACHE_KEY, THEME_CACHE_MAX } from '../keys';

const cache = () => JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || 'null');

beforeEach(() => {
  localStorage.clear();
  removeThemeCSS();
  removeThemeSkinCSS();
  document.documentElement.removeAttribute('data-theme-skin');
});

describe('theme cache for the boot script', () => {
  it('keeps a copy of the injected colour block and skin', () => {
    injectThemeCSS(':root{--color-primary:#f00}');
    injectThemeSkinCSS('body[data-theme-skin="t1"] .toolbar{gap:2px}', 't1');
    expect(cache()).toEqual({
      v: 1,
      css: ':root{--color-primary:#f00}',
      skin: 'html[data-theme-skin="t1"] body .toolbar{gap:2px}',
      skinId: 't1',
    });
  });

  it('drops the parts that are removed, and the whole entry when nothing is left', () => {
    injectThemeCSS('a{}');
    injectThemeSkinCSS('b{}', 't1');
    removeThemeSkinCSS();
    expect(cache()).toEqual({ v: 1, css: 'a{}' });
    removeThemeCSS();
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it('does not cache a theme too large for localStorage', () => {
    injectThemeCSS('a{}');
    injectThemeCSS(`:root{--x:"${'y'.repeat(THEME_CACHE_MAX)}"}`);
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
    expect(document.getElementById('active-theme')?.textContent).toContain('--x');
  });

  it('clears the boot copy\'s <html> attribute once the real skin is on <body>', () => {
    document.documentElement.setAttribute('data-theme-skin', 't1');
    injectThemeSkinCSS('b{}', 't1');
    expect(document.body.getAttribute('data-theme-skin')).toBe('t1');
    expect(document.documentElement.hasAttribute('data-theme-skin')).toBe(false);
  });

  it('reuses a <style> element the boot script already created', () => {
    const el = document.createElement('style');
    el.id = 'active-theme';
    el.textContent = 'old{}';
    document.head.appendChild(el);
    injectThemeCSS('new{}');
    expect(document.querySelectorAll('#active-theme')).toHaveLength(1);
    expect(el.textContent).toBe('new{}');
  });
});

describe('bootSkinCSS', () => {
  it.each([
    ['body[data-theme-skin="x"]{a:b}', 'html[data-theme-skin="x"] body{a:b}'],
    ["body[data-theme-skin='x'] .row, body[data-theme-skin] p{}", "html[data-theme-skin='x'] body .row, html[data-theme-skin] body p{}"],
    ['.toolbar{a:b}', '.toolbar{a:b}'],
    ['tbody[data-theme-skin="x"]{}', 'tbody[data-theme-skin="x"]{}'],
  ])('rewrites %s', (input, output) => {
    expect(bootSkinCSS(input)).toBe(output);
  });
});
