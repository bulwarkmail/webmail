import { describe, it, expect, afterEach } from 'vitest';
import { useSettingsStore } from '../settings-store';

/**
 * Turning animations off has to reach the CSS: transitions and animations use
 * fixed durations, so globals.css keys off `data-animations="off"` (#1215).
 */
describe('animationsEnabled setting', () => {
  afterEach(() => {
    useSettingsStore.getState().updateSetting('animationsEnabled', true);
  });

  it('marks the document when animations are disabled', () => {
    useSettingsStore.getState().updateSetting('animationsEnabled', false);
    expect(document.documentElement.dataset.animations).toBe('off');
  });

  it('removes the mark when animations are enabled again', () => {
    useSettingsStore.getState().updateSetting('animationsEnabled', false);
    useSettingsStore.getState().updateSetting('animationsEnabled', true);
    expect(document.documentElement.dataset.animations).toBeUndefined();
  });
});
