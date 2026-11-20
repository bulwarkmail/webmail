import { describe, expect, it } from 'vitest';
import { doubleClickOpensWindow } from '../popout/double-click';
import { adminPolicyPatch } from '@/stores/settings-store';

// #1814: "Double-click a message" opens a new window where messages can
// open in one; the desktop app keeps its own switch.

const base = { canOpenWindow: true, isMobile: false, desktopApp: false, desktopOpenOnDoubleClick: true, messageDoubleClick: 'reading-pane' as const };

describe('doubleClickOpensWindow', () => {
  it('follows the Reading setting in an installed app', () => {
    expect(doubleClickOpensWindow(base)).toBe(false);
    expect(doubleClickOpensWindow({ ...base, messageDoubleClick: 'new-window' })).toBe(true);
  });

  it('follows its own switch in the desktop app', () => {
    expect(doubleClickOpensWindow({ ...base, desktopApp: true })).toBe(true);
    expect(doubleClickOpensWindow({ ...base, desktopApp: true, desktopOpenOnDoubleClick: false, messageDoubleClick: 'new-window' })).toBe(false);
  });

  it('stays as today where no window can open, and on a phone', () => {
    expect(doubleClickOpensWindow({ ...base, canOpenWindow: false, messageDoubleClick: 'new-window' })).toBe(false);
    expect(doubleClickOpensWindow({ ...base, isMobile: true, messageDoubleClick: 'new-window' })).toBe(false);
  });
});

describe('admin default for "Double-click a message"', () => {
  it('applies a known value and skips an unknown one', () => {
    const state = { messageDoubleClick: 'reading-pane', explicitSettings: [] };
    expect(adminPolicyPatch(state, { defaults: { messageDoubleClick: 'new-window' } })).toEqual({ messageDoubleClick: 'new-window' });
    expect(adminPolicyPatch(state, { defaults: { messageDoubleClick: 'tab' } })).toEqual({});
  });
});
