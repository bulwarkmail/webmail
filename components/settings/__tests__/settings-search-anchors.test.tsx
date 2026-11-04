import 'fake-indexeddb/auto';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';

// R-SET-5: every settings search result lands on a row of its page. This
// renders every settings page in English, with the Advanced switch on and
// off and in the situations some rows need (touch screen, Mountain View,
// several accounts), and checks that each entry of the search index has a
// row marked with its label, and is advanced exactly when the page says so.
// settings-8 (2026-11-04): and that every section a page draws can be found,
// so a new section (offline, app lock) can't be left out of the index.
// settings-p2-5 (2026-11-04): and in the desktop app, with its bridge
// there, so the app's own rows (tray, quiet hours, menu bar) are found too.

vi.unmock('next-intl');
vi.mock('@/components/plugins/plugin-iframe-slot', () => ({ PluginIframeSlot: () => null }));
// Recover deleted items asks the server first; here it has the feature.
vi.mock('@/hooks/use-deleted-items-recovery', async () => {
  const { useAuthStore } = await import('@/stores/auth-store');
  return {
    useDeletedItemsRecovery: () => {
      const client = useAuthStore((s) => s.client);
      return { available: true, off: false, pending: false, client, key: 'acc' };
    },
  };
});

const { useSettingsStore } = await import('@/stores/settings-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useVacationStore } = await import('@/stores/vacation-store');
const { useFilterStore } = await import('@/stores/filter-store');
const { useAccountSecurityStore } = await import('@/stores/account-security-store');
const { useCalendarStore } = await import('@/stores/calendar-store');
const { useContactStore } = await import('@/stores/contact-store');
const { useEmailStore } = await import('@/stores/email-store');
const { useAccountStore } = await import('@/stores/account-store');
const { useFilesSyncStore } = await import('@/stores/files-sync-store');
const { TourProvider } = await import('@/components/tour/tour-provider');
const { AdvancedSettingsProvider } = await import('../settings-section');
const { tabSearchEntries, getByPath, withAppName, settingsTabLabelKey } = await import('@/lib/settings-search');
const { setStoreBackend } = await import('@/lib/store/client/api');
const pages = {
  account: (await import('../account-settings')).AccountSettings,
  general: (await import('../general-settings')).GeneralSettings,
  notifications: (await import('../notification-settings')).NotificationSettings,
  appearance: (await import('../appearance-settings')).AppearanceSettings,
  accessibility: (await import('../accessibility-settings')).AccessibilitySettings,
  message_list: (await import('../message-list-settings')).MessageListSettings,
  reading: (await import('../reading-settings')).ReadingSettings,
  composing: (await import('../composing-settings')).ComposingSettings,
  vacation: (await import('../vacation-settings')).VacationSettings,
  filters: (await import('../filter-settings')).FilterSettings,
  organize: (await import('../organize-settings')).OrganizeSettings,
  security: (await import('../account-security-settings')).AccountSecuritySettings,
  sharing: (await import('../delegates/delegates-settings')).DelegatesSettings,
  recovery: (await import('../recover-deleted-settings')).RecoverDeletedSettings,
  calendar: (await import('../calendar-settings')).CalendarSettings,
  calendar2: (await import('../calendar-management-settings')).CalendarManagementSettings,
  contacts: (await import('../contacts-settings')).ContactsSettings,
  contacts2: (await import('../address-book-management-settings')).AddressBookManagementSettings,
  files: (await import('../files-settings')).FilesSettingsComponent,
  files_sync: (await import('../desktop-files-settings')).DesktopFilesSettings,
  addons: (await import('../addons-settings')).AddonsSettings,
  backup: (await import('../about-data-settings')).AboutDataSettings,
  offline: (await import('@/components/offline/offline-settings')).OfflineSettings,
  privacy: (await import('../privacy-settings')).PrivacySettings,
  about: (await import('../about-data-settings')).AboutSettings,
};

const OVERRIDES: Record<string, () => unknown> = {
  getAccountId: () => 'acc', getSieveAccountId: () => 'acc', getUsername: () => 'user@example.com',
  getSharedAccounts: () => [], getSieveAccounts: () => [], getSieveCapabilities: () => null,
  hasAccountCapability: () => false, supportsCalendars: () => true, supportsPrincipals: () => true, supportsFiles: () => true, hasDelayedSend: () => true,
  // Sharing and Recover deleted items read these on open.
  getShareTargets: async () => ({ targets: [], failed: [] }), listPrincipals: async () => ({ principals: [], status: 'ok' }),
  getPrincipals: async () => [], listArchivedEmails: async () => ({ items: [], nextPosition: null }),
};
/** Pages with rows of the desktop app's own, or browser rows it hides. */
const DESKTOP_PAGES = new Set(['general', 'notifications', 'privacy', 'backup', 'files_sync']);

/** The desktop app's bridge, answering as Windows does, with every switch off. */
const DESKTOP_BRIDGE = {
  version: 1,
  platform: 'win32',
  mode: 'standalone',
  windows: {},
  menu: { bar: { setPinned: () => {}, onEvent: () => () => {} } },
  os: {
    getStatus: async () => ({
      settings: {
        closeToTray: false, startAtLogin: false, startMinimized: false, attentionOnNewMail: false,
        quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null,
      },
      pausedUntil: null,
      shortcutActive: false,
    }),
    defaultAppStatus: async () => ({ registered: true, mailto: false, webcal: false }),
    onStatusChange: () => () => {},
    setSettings: async () => { throw new Error('not here'); },
    openDefaultAppSettings: async () => ({ registered: true, mailto: false, webcal: false }),
  },
  updates: {
    state: async () => ({ version: '1.0.0', channel: 'stable', channelLocked: false, allowed: true, ability: 'install', perMachine: false, status: 'idle' }),
    onChanged: () => () => {},
  },
  devTools: { get: async () => ({ on: false, forcedOff: false, locked: false }), set: async () => ({ on: false, forcedOff: false, locked: false }), onChange: () => () => {} },
  privacy: {
    get: async () => ({ telemetry: { on: false, forcedOff: false }, crashReports: { on: false, forcedOff: false, uploadUrl: '' } }),
    listCrashes: async () => [],
    onChange: () => () => {},
  },
};

const CLIENT = new Proxy({}, {
  get: (_t, prop) => (prop === 'then' ? undefined : (OVERRIDES[String(prop)] ?? (() => null))),
});

// The settings tabs and the components settings-app.tsx draws for them.
const TAB_PAGES: Record<string, string[]> = {
  account: ['account'], general: ['general'], notifications: ['notifications'], appearance: ['appearance'],
  accessibility: ['accessibility'],
  message_list: ['message_list'], reading: ['reading'], composing: ['composing'], vacation: ['vacation'],
  filters: ['filters'], organize: ['organize'], security: ['security'], sharing: ['sharing'], recovery: ['recovery'], calendar: ['calendar', 'calendar2'],
  contacts: ['contacts', 'contacts2'], files: ['files'], files_sync: ['files_sync'], addons: ['addons'], backup: ['backup'],
  offline: ['offline'], privacy: ['privacy'], about: ['about'],
};

describe('settings search index', () => {
  it('has a row for every entry on its page', { timeout: 180_000 }, async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));
    useAuthStore.setState({ isAuthenticated: true, authMode: 'basic', client: CLIENT, activeAccountId: 'acc' } as never);
    useVacationStore.setState({ isSupported: true, isLoading: false, forwardAvailable: true, fetchVacationResponse: vi.fn(async () => {}) } as never);
    useFilterStore.setState({ isSupported: true, isLoading: false, rules: [], selectAccount: vi.fn(async () => {}) } as never);
    useAccountSecurityStore.setState({ isStalwart: true, isProbing: false, probe: vi.fn(async () => true), fetchAll: vi.fn(), fetchAuthInfo: vi.fn(), fetchPublicKeys: vi.fn(), fetchCryptoInfo: vi.fn() } as never);
    useCalendarStore.setState({ calendars: [{ id: 'c', name: 'Work', color: '#3b82f6', isDefault: false, isShared: false, shareWith: null, myRights: { mayShare: true, mayDelete: true, mayWriteAll: true } }], icalSubscriptions: [] } as never);
    useContactStore.setState({ addressBooks: [{ id: 'b', name: 'Club', isDefault: true, isShared: false, shareWith: null, myRights: { mayRead: true, mayWrite: true, mayDelete: true } }], contacts: [], fetchAddressBooks: vi.fn(async () => {}) } as never);
    useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}) } as never);
    // jsdom has no OPFS: the store says it's there, as a browser would, so Offline draws its rows.
    setStoreBackend({ supported: () => true } as never);
    const out: Record<string, Record<string, { on: string[]; off: string[]; sections: string[]; error?: string }>> = {};
    const realMatchMedia = window.matchMedia;
    const variants: Record<string, () => void> = {
      base: () => {},
      desktop: () => {
        window.bulwarkDesktop = DESKTOP_BRIDGE as never;
        // Files on this computer: the engine runs, on Windows, with the drive on offer.
        useFilesSyncStore.setState({
          available: true,
          account: 'acc',
          drive: { supported: true, forcedOff: false, wanted: [], letter: { letter: null, chosen: null, locked: false, available: ['Z'] } },
        });
      },
      touch: () => {
        window.matchMedia = ((q: string) => ({ ...realMatchMedia(q), matches: q.includes('coarse') })) as typeof window.matchMedia;
      },
      mountainView: () => { useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never); },
      multiAccount: () => {
        useAccountStore.setState({ accounts: [
          { id: 'a', label: 'A', email: 'a@example.com', username: 'a@example.com', serverUrl: 'https://x', isDefault: true },
          { id: 'b', label: 'B', email: 'b@example.com', username: 'b@example.com', serverUrl: 'https://x', isDefault: false },
        ] } as never);
      },
    };
    const settingsInitial = useSettingsStore.getState();
    const accountsInitial = useAccountStore.getState();
    for (const [variant, apply] of Object.entries(variants)) {
    useSettingsStore.setState(settingsInitial, true);
    useAccountStore.setState(accountsInitial, true);
    window.matchMedia = realMatchMedia;
    window.bulwarkDesktop = undefined;
    useFilesSyncStore.getState().reset();
    apply();
    out[variant] = {};
    for (const [tab, Page] of Object.entries(pages)) {
      // The desktop app changes only these pages; the others are the browser's.
      if (variant === 'desktop' && !DESKTOP_PAGES.has(tab)) {
        out[variant][tab] = out.base[tab];
        continue;
      }
      const draw = (adv: boolean) => {
        useSettingsStore.setState({ showAdvancedSettings: adv });
        return render(
          <NextIntlClientProvider locale="en" messages={en}>
            <TourProvider>
              <AdvancedSettingsProvider>
                <Page supportsCalendar />
              </AdvancedSettingsProvider>
            </TourProvider>
          </NextIntlClientProvider>,
        );
      };
      const read = ({ container, unmount }: ReturnType<typeof draw>) => {
        const found = Array.from(container.querySelectorAll('[data-search-label]')).map((el) => el.getAttribute('data-search-label') ?? '');
        const sections = Array.from(container.querySelectorAll('[data-settings-section]')).map((el) => el.getAttribute('data-search-label') ?? '');
        unmount();
        return { found, sections };
      };
      // The desktop rows draw once the bridge has answered. Elsewhere nothing
      // waits: the pages' own loads would answer from the stub client.
      const labels = async (adv: boolean) => {
        const view = draw(adv);
        if (variant === 'desktop') await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        return read(view);
      };
      try {
        const on = variant === 'desktop' ? await labels(true) : read(draw(true));
        const off = variant === 'desktop' ? await labels(false) : read(draw(false));
        out[variant][tab] = { on: on.found, off: off.found, sections: on.sections };
      } catch (e) {
        out[variant][tab] = { on: [], off: [], sections: [], error: String(e) };
      }
    }
    }
    window.matchMedia = realMatchMedia;
    window.bulwarkDesktop = undefined;

    const problems: string[] = [];
    for (const [tab, entries] of Object.entries(tabSearchEntries)) {
      for (const entry of entries) {
        // Rows that name the app show the stock name, as the index does.
        const text = withAppName(getByPath(en, entry.label), 'Bulwark') as string;
        // The desktop app's rows are all drawn in the Windows variant; a Mac row there is the Dock's.
        const variantName = entry.when?.startsWith('desktop') ? 'desktop' : entry.when === 'browser' ? 'base' : (entry.when ?? 'base');
        if (entry.when === 'desktopMac') continue;
        const variant = out[variantName];
        const parts = TAB_PAGES[tab].map((page) => variant[page]);
        const errors = parts.filter((part) => part.error).map((part) => part.error);
        if (errors.length) { problems.push(`${tab}: ${errors.join('; ')}`); continue; }
        const withAdvanced = parts.some((part) => part.on.includes(text));
        const withoutAdvanced = parts.some((part) => part.off.includes(text));
        if (!withAdvanced) problems.push(`${tab}: no row for ${entry.label} ("${text}")`);
        else if (!!entry.advanced === withoutAdvanced) {
          problems.push(`${tab}: ${entry.label} is ${withoutAdvanced ? 'not ' : ''}an advanced row`);
        }
      }
    }
    // A browser's row isn't in the desktop app (the push section, the browser's mail links).
    for (const [tab, entries] of Object.entries(tabSearchEntries)) {
      for (const entry of entries.filter((e) => e.when === 'browser')) {
        const text = withAppName(getByPath(en, entry.label), 'Bulwark') as string;
        if (TAB_PAGES[tab].some((page) => out.desktop[page].on.includes(text))) problems.push(`${tab}: ${entry.label} is drawn in the desktop app`);
      }
    }
    // Every section a page draws has an entry, so searching its name finds it.
    for (const [tab, entries] of Object.entries(tabSearchEntries)) {
      const indexed = new Set(entries.map((entry) => withAppName(getByPath(en, entry.label), 'Bulwark') as string));
      // A section named like its page is the page itself, which the search lists anyway.
      indexed.add(getByPath(en, settingsTabLabelKey(tab as never)) as string);
      for (const page of TAB_PAGES[tab]) {
        for (const section of [...out.base[page].sections, ...out.desktop[page].sections]) {
          if (!indexed.has(section)) problems.push(`${tab}: section "${section}" has no search entry`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});

// Rows only a browser draws are not in the desktop app, and the other way round.
describe('settings search index, browser and desktop app', () => {
  it('marks the rows each draws', () => {
    const when = (label: string) => Object.values(tabSearchEntries).flat().find((entry) => entry.label === label)?.when;
    expect(when('settings.notifications.push.title')).toBe('browser');
    expect(when('desktopOs.close_to_tray_label')).toBe('desktop');
    expect(when('desktopOs.quiet_hours_label')).toBe('desktop');
    expect(when('desktopMenuBar.always_show_label')).toBe('desktopMenuBar');
  });
});
