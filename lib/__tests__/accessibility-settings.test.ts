import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESSIBILITY_DEFAULTS,
  accessibilityBootScript,
  applyAccessibilityTo,
  isAllowedAccessibilityValue,
  toastDurationAtLeast,
} from '../accessibility-settings';

const root = () => document.documentElement;

afterEach(() => {
  for (const name of root().getAttributeNames()) if (name.startsWith('data-')) root().removeAttribute(name);
  root().style.removeProperty('--font-size-base');
  localStorage.clear();
});

describe('applyAccessibilityTo', () => {
  it('sets the text size as a percentage of the browser default, not in pixels', () => {
    applyAccessibilityTo(root(), { fontSize: 'medium' });
    expect(root().style.getPropertyValue('--font-size-base')).toBe('100%');
    applyAccessibilityTo(root(), { fontSize: 'huge' });
    expect(root().style.getPropertyValue('--font-size-base')).toBe('200%');
    applyAccessibilityTo(root(), { fontSize: 'small' });
    expect(root().style.getPropertyValue('--font-size-base')).toBe('87.5%');
  });

  it('writes nothing for "follow the system", so the media queries decide', () => {
    applyAccessibilityTo(root(), { ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium' });
    // The focus outline is the one default that is not the stylesheet's own.
    expect(root().getAttributeNames().filter((n) => n.startsWith('data-'))).toEqual(['data-focus-ring']);
  });

  it('leaves the focus outline off by default', () => {
    expect(ACCESSIBILITY_DEFAULTS.focusRing).toBe('off');
    applyAccessibilityTo(root(), { ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium' });
    expect(root().dataset.focusRing).toBe('off');
  });

  it('marks explicit overrides either way', () => {
    applyAccessibilityTo(root(), { reduceMotion: 'on', contrast: 'more', reduceTransparency: 'off' });
    expect(root().dataset.motion).toBe('reduce');
    expect(root().dataset.animations).toBe('off');
    expect(root().dataset.contrast).toBe('more');
    expect(root().dataset.transparency).toBe('full');

    applyAccessibilityTo(root(), { reduceMotion: 'off', contrast: 'normal' });
    expect(root().dataset.motion).toBe('full');
    expect(root().dataset.animations).toBeUndefined();
    expect(root().dataset.contrast).toBe('normal');
    expect(root().dataset.transparency).toBeUndefined();
  });

  it('removes an attribute again when the option goes back to what the stylesheet does unasked', () => {
    applyAccessibilityTo(root(), { appFont: 'lexend', focusRing: 'extra', underlineLinks: true });
    expect(root().dataset.appFont).toBe('lexend');
    expect(root().dataset.focusRing).toBe('extra');
    expect(root().dataset.underlineLinks).toBe('on');
    applyAccessibilityTo(root(), { appFont: 'default', focusRing: 'normal', underlineLinks: false });
    expect(root().dataset.appFont).toBeUndefined();
    expect(root().dataset.focusRing).toBeUndefined();
    expect(root().dataset.underlineLinks).toBeUndefined();
  });

  it('marks a focus outline that is turned off', () => {
    applyAccessibilityTo(root(), { focusRing: 'off' });
    expect(root().dataset.focusRing).toBe('off');
  });

  // A Windows contrast theme keeps the outline unless Off was chosen.
  it('tells an Off the user chose from Off as the default', () => {
    applyAccessibilityTo(root(), { ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium', explicitSettings: [] });
    expect(root().dataset.focusRing).toBe('off');
    expect(root().dataset.focusRingChosen).toBeUndefined();

    applyAccessibilityTo(root(), { ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium', explicitSettings: ['fontSize', 'focusRing'] });
    expect(root().dataset.focusRing).toBe('off');
    expect(root().dataset.focusRingChosen).toBe('on');

    applyAccessibilityTo(root(), { ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium', explicitSettings: ['fontSize'] });
    expect(root().dataset.focusRingChosen).toBeUndefined();
  });
});

describe('accessibilityBootScript', () => {
  it('runs on its own before React and applies the persisted settings', () => {
    localStorage.setItem('settings-storage', JSON.stringify({
      state: { fontSize: 'xx-large', contrast: 'more', reduceMotion: 'on' },
      version: 9,
    }));
    // Indirect eval runs in global scope: anything the function borrowed
    // from its module would be undefined here and throw (caught silently,
    // so the attributes would stay unset).
    (0, eval)(accessibilityBootScript());
    expect(root().style.getPropertyValue('--font-size-base')).toBe('150%');
    expect(root().dataset.contrast).toBe('more');
    expect(root().dataset.motion).toBe('reduce');
  });

  it('marks a chosen focus outline before React loads', () => {
    localStorage.setItem('settings-storage', JSON.stringify({
      state: { fontSize: 'medium', focusRing: 'off', explicitSettings: ['focusRing'] },
      version: 16,
    }));
    (0, eval)(accessibilityBootScript());
    expect(root().dataset.focusRing).toBe('off');
    expect(root().dataset.focusRingChosen).toBe('on');
  });

  it('does nothing without stored settings', () => {
    (0, eval)(accessibilityBootScript());
    expect(root().style.getPropertyValue('--font-size-base')).toBe('');
  });
});

describe('allowed values', () => {
  it('rejects values the stylesheet does not know', () => {
    expect(isAllowedAccessibilityValue('fontSize', 'huge')).toBe(true);
    expect(isAllowedAccessibilityValue('fontSize', 'enormous')).toBe(false);
    expect(isAllowedAccessibilityValue('reduceMotion', true)).toBe(false);
    expect(isAllowedAccessibilityValue('toastDuration', 7)).toBe(false);
    expect(isAllowedAccessibilityValue('readAloudVoice', 'Anna')).toBe(true);
  });

  it('counts "until closed" as meeting any toast minimum', () => {
    expect(toastDurationAtLeast(0, 20)).toBe(true);
    expect(toastDurationAtLeast(10, 20)).toBe(false);
    expect(toastDurationAtLeast(20, 20)).toBe(true);
  });
});
