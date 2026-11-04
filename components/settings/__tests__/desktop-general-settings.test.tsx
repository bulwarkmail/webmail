import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import en from '@/locales/en/common.json';

vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));

const { ProtocolHandlerSettings } = await import('../protocol-handler-settings');

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
});

describe('Settings > General in the desktop app', () => {
  it('a browser keeps its "Default apps" section', () => {
    render(<ProtocolHandlerSettings supportsCalendar />);
    expect(screen.getByText('register_mailto')).toBeTruthy();
  });

  it('the desktop app shows only its own "Default mail app" row, not the browser\'s handlers', () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32' } as unknown as BulwarkDesktopBridge;
    render(<ProtocolHandlerSettings supportsCalendar />);
    expect(screen.queryByText('register_mailto')).toBeNull();
    expect(screen.queryByText('title')).toBeNull();
  });

  it('the section about the app\'s windows isn\'t called "Windows", which reads as the OS', () => {
    expect(en.desktopUi.settings.title).not.toBe('Windows');
    expect(en.desktopUi.settings.title).toBe('App windows');
  });
});
