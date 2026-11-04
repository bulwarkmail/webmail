import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { useAccountStore } from '@/stores/account-store';

// settings-p3-2, desktop-p3-16 (usability pass 3, 2026-11-04): in the desktop app the
// settings talked about "your browser", "the tab" and "the webmail"; in a browser the
// Notifications page named "the tray". The pages are rendered in English here, as
// people read them, once in the app (its bridge there) and once in a browser.

vi.unmock('next-intl');
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark', settingsSyncEnabled: false }) }));
vi.mock('@/lib/web-push', () => ({
  WebPushUnsupportedError: class WebPushUnsupportedError extends Error {},
  isWebPushSupported: () => false,
  isWebPushEnabled: vi.fn(async () => false),
  enableWebPush: vi.fn(),
  enableWebPushForAccounts: vi.fn(),
  disableWebPush: vi.fn(),
  listPushDevices: vi.fn(async () => []),
  mailAccountsWithoutPush: vi.fn(() => []),
  revokePushDevice: vi.fn(),
  serverSupportsEmailPush: vi.fn(() => false),
}));

const { NotificationSettings } = await import('../notification-settings');
const { AccessibilitySettings } = await import('../accessibility-settings');
const { ProofreadingSettings } = await import('../proofreading-settings');
const { AppearanceSettings } = await import('../appearance-settings');
const { AdvancedSettingsProvider } = await import('../settings-section');

const osStatus = {
  settings: {
    closeToTray: true, startAtLogin: false, startMinimized: false, attentionOnNewMail: true,
    quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null,
  },
  pausedUntil: null,
  shortcutActive: false,
};

function installBridge() {
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    os: {
      getStatus: vi.fn(async () => osStatus),
      defaultAppStatus: vi.fn(async () => ({ mailto: false })),
      onStatusChange: vi.fn(() => () => {}),
      setSettings: vi.fn(async () => osStatus),
      openDefaultAppSettings: vi.fn(),
    },
  };
}

async function textOf(page: React.ReactNode): Promise<string> {
  const { container, unmount } = render(
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      <AdvancedSettingsProvider>{page}</AdvancedSettingsProvider>
    </NextIntlClientProvider>,
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  // Each text node on its own, so words of neighbouring elements don't run together
  // ("webmailLight" has no word boundary). Select options count: "Browser default" was one.
  const parts: string[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? '');
  const text = parts.join(' ');
  unmount();
  return text;
}

const BROWSER_WORDS = /\bbrowser'?s?\b|\btabs?\b|\bwebsites?\b|\bwebmail\b/i;

beforeEach(() => {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: true });
  // "Count unread mail in all accounts" shows only with a second account.
  useAccountStore.setState({ accounts: [{ id: 'a' }, { id: 'b' }] as never });
});

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  useAccountStore.setState({ accounts: [] });
});

describe('settings words in the desktop app', () => {
  it.each([
    ['Accessibility', () => <AccessibilitySettings />],
    ['Composing (writing language)', () => <ProofreadingSettings />],
    ['Notifications', () => <NotificationSettings />],
    ['Appearance', () => <AppearanceSettings />],
  ])('%s says nothing about a browser, a tab or the webmail', async (_name, page) => {
    installBridge();
    const text = await textOf(page());
    expect(text.length).toBeGreaterThan(100);
    expect(text.match(BROWSER_WORDS)?.[0] ?? null).toBeNull();
  });

  it('Appearance names the product', async () => {
    installBridge();
    expect(await textOf(<AppearanceSettings />)).toContain('Change how Bulwark looks.');
  });

  it('names the taskbar and the tray for the unread count of all accounts', async () => {
    installBridge();
    const text = await textOf(<NotificationSettings />);
    expect(text).toContain(en.ux_p3_words.badge_all_app);
  });

  it('offers the system voice, not the browser default', async () => {
    installBridge();
    const text = await textOf(<AccessibilitySettings />);
    expect(text).toContain(en.ux_p3_words.voice_default_app);
  });
});

describe('the same pages in a browser', () => {
  it('Notifications names the tab, and no tray a browser does not have', async () => {
    const text = await textOf(<NotificationSettings />);
    expect(text).toContain(en.ux_p3_words.badge_all_browser);
    expect(text).not.toMatch(/\btray\b/i);
  });

  it('Accessibility keeps the browser\'s own words where they are true', async () => {
    const text = await textOf(<AccessibilitySettings />);
    expect(text).toContain(en.settings.accessibility.text_size.description);
    expect(text).toContain(en.settings.accessibility.read_aloud_voice.default);
  });
});
