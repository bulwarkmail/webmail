import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/common.json';

// SET-5: a search result whose row the page didn't show turned the synced
// Advanced switch on. Only a row known to be advanced may do that now.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useMessages: () => en,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/hooks/use-media-query', () => ({
  useIsDesktop: () => true,
  useIsMobile: () => false,
  useMediaQuery: () => false,
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: false }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/settings/appearance-settings', () => ({ AppearanceSettings: () => null }));
vi.mock('@/components/settings/accessibility-settings', () => ({ AccessibilitySettings: () => null }));
// The page is not drawn here, so no result finds its row.
vi.mock('@/components/settings/message-list-settings', () => ({ MessageListSettings: () => null }));

const { SettingsApp } = await import('../settings-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { useSettingsStore } = await import('@/stores/settings-store');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  const client = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : (prop === 'getAccountId' ? () => 'acc' : () => null)),
  });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: client as never });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
  useSettingsStore.setState({ showAdvancedSettings: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openResult(query: string, label: string) {
  render(<SettingsApp linkSegments={[]} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: label }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
}

describe('settings search and the Advanced switch', () => {
  it('leaves Advanced off for a row that is not an advanced one', async () => {
    await openResult('favicons', 'Sender favicons');
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
  });

  it('turns Advanced on for an advanced row it has to reveal', async () => {
    await openResult('emails per page', 'Emails per page');
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(true);
  });
});

describe('settings finder navigation', () => {
  it('moves from the search field through results without activating a page, and returns with Escape', () => {
    render(<SettingsApp linkSegments={[]} />);
    const search=screen.getByRole('searchbox');
    fireEvent.change(search,{target:{value:'font'}});
    const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-memail-settings-result]'));
    expect(buttons.length).toBeGreaterThan(1);
    fireEvent.keyDown(search,{key:'ArrowDown'});
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0],{key:'ArrowDown'});
    expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(buttons[1],{key:'End'});
    expect(buttons[buttons.length-1]).toHaveFocus();
    fireEvent.keyDown(buttons[buttons.length-1],{key:'Home'});
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0],{key:'Escape'});
    expect(search).toHaveFocus();
    expect(search).toHaveValue('font');
    fireEvent.keyDown(search,{key:'Escape'});
    expect(search).toHaveValue('');
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
  });
  it('recovers from no matches and returns focus to settings search', () => {
    render(<SettingsApp linkSegments={[]} />);
    const search=screen.getByRole('searchbox');
    fireEvent.change(search,{target:{value:'zzzz-no-matching-setting'}});
    expect(screen.getByRole('status')).toHaveTextContent('settings.search_no_results');
    fireEvent.click(within(screen.getByRole('status').parentElement!).getByRole('button',{name:'settings.search_clear'}));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
  });
  it('reveals matches beyond six without changing settings and resets expansion for a new query', () => {
    render(<SettingsApp linkSegments={[]} />);
    const search=screen.getByRole('searchbox');
    fireEvent.change(search,{target:{value:'message'}});
    const more=screen.getAllByRole('button',{name:/Show all .* matches/})[0];
    expect(more).toHaveAttribute('aria-expanded','false');
    const matches=document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(matches.querySelectorAll('button')).toHaveLength(6);
    const total=Number(more.textContent?.match(/\d+/)?.[0]);
    fireEvent.click(more);
    expect(matches.querySelectorAll('button')).toHaveLength(total);
    expect(screen.getByRole('button',{name:'Show fewer matches'})).toHaveAttribute('aria-expanded','true');
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
    fireEvent.change(search,{target:{value:'message text'}});
    expect(screen.queryByRole('button',{name:'Show fewer matches'})).toBeNull();
  });
});
