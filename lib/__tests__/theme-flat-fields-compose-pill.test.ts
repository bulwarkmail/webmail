import { afterEach, describe, expect, it } from 'vitest';
import { flatFieldsCSS, flatFieldsSkin } from '../theme-flat-fields';

// The sidebar's Compose button is the one always-full-round element in the
// default skin (rounded-full). Flat fields is a square system: every radius
// token is 0 or 2px, and its `.rounded-full:not(.animate-spin)` rule must
// square the pill too, so the one main action doesn't float as a lone circle
// over an otherwise square UI.

function mountButton(classAttr: string) {
  document.body.setAttribute('data-theme-skin', 'builtin-flat-fields');
  const style = document.createElement('style');
  // The app's own utility, which the skin has to beat, and the token value
  // the skin's radius rules resolve against (from flatFieldsCSS).
  style.textContent = '.rounded-full { border-radius: 9999px; }' + flatFieldsCSS + flatFieldsSkin;
  document.head.appendChild(style);
  document.body.innerHTML = `
    <div data-tour="sidebar">
      <button id="compose" data-tour="compose-button" class="${classAttr}">写邮件</button>
    </div>`;
  return getComputedStyle(document.getElementById('compose')!).borderRadius;
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.removeAttribute('data-theme-skin');
});

describe('Flat fields squares the Compose pill', () => {
  it('flattens the sidebar button with rounded-full (2px, not 9999px)', () => {
    // The Button default plus the pill class, as sidebar.tsx renders it.
    // jsdom keeps var() unresolved, so assert the token the skin sets and
    // that the app's 9999px literal is beaten.
    const radius = mountButton('inline-flex items-center justify-center rounded-full h-9 px-3 font-medium bg-primary');
    expect(radius).toBe('var(--radius-md)');
    expect(radius).not.toBe('9999px');
  });

  it('leaves spinners round', () => {
    document.body.setAttribute('data-theme-skin', 'builtin-flat-fields');
    const style = document.createElement('style');
    style.textContent = '.rounded-full { border-radius: 9999px; }' + flatFieldsCSS + flatFieldsSkin;
    document.head.appendChild(style);
    document.body.innerHTML = '<div id="spin" class="rounded-full animate-spin"></div>';
    expect(getComputedStyle(document.getElementById('spin')!).borderRadius).toBe('9999px');
  });
});
