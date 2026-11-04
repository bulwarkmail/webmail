import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';

// R-SET-5: every settings search result lands on a row of its page. This
// renders every settings page in English, with the Advanced switch on and
// off and in the situations some rows need (touch screen, Mountain View,
// several accounts), and checks that each entry of the search index has a
// row marked with its label, and is advanced exactly when the page says so.

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
const { TourProvider } = await import('@/components/tour/tour-provider');
const { AdvancedSettingsProvider } = await import('../settings-section');
const { tabSearchEntries, getByPath, withAppName } = await import('@/lib/settings-search');
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
  addons: (await import('../addons-settings')).AddonsSettings,
  backup: (await import('../about-data-settings')).AboutDataSettings,
};

const OVERRIDES: Record<string, () => unknown> = {
  getAccountId: () => 'acc', getSieveAccountId: () => 'acc', getUsername: () => 'user@example.com',
  getSharedAccounts: () => [], getSieveAccounts: () => [], getSieveCapabilities: () => null,
  hasAccountCapability: () => false, supportsCalendars: () => true, supportsPrincipals: () => true, supportsFiles: () => true, hasDelayedSend: () => true,
  // Sharing and Recover deleted items read these on open.
  getShareTargets: async () => ({ targets: [], failed: [] }), listPrincipals: async () => ({ principals: [], status: 'ok' }),
  getPrincipals: async () => [], listArchivedEmails: async () => ({ items: [], nextPosition: null }),
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
  contacts: ['contacts', 'contacts2'], files: ['files'], addons: ['addons'], backup: ['backup'],
};

describe('settings search index', () => {
  it('has a row for every entry on its page', { timeout: 120_000 }, () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));
    useAuthStore.setState({ isAuthenticated: true, authMode: 'basic', client: CLIENT } as never);
    useVacationStore.setState({ isSupported: true, isLoading: false, forwardAvailable: true, fetchVacationResponse: vi.fn(async () => {}) } as never);
    useFilterStore.setState({ isSupported: true, isLoading: false, rules: [], selectAccount: vi.fn(async () => {}) } as never);
    useAccountSecurityStore.setState({ isStalwart: true, isProbing: false, probe: vi.fn(async () => true), fetchAll: vi.fn(), fetchAuthInfo: vi.fn(), fetchPublicKeys: vi.fn(), fetchCryptoInfo: vi.fn() } as never);
    useCalendarStore.setState({ calendars: [{ id: 'c', name: 'Work', color: '#3b82f6', isDefault: false, isShared: false, shareWith: null, myRights: { mayShare: true, mayDelete: true, mayWriteAll: true } }], icalSubscriptions: [] } as never);
    useContactStore.setState({ addressBooks: [{ id: 'b', name: 'Club', isDefault: true, isShared: false, shareWith: null, myRights: { mayRead: true, mayWrite: true, mayDelete: true } }], contacts: [], fetchAddressBooks: vi.fn(async () => {}) } as never);
    useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}) } as never);
    const out: Record<string, Record<string, { on: string[]; off: string[]; error?: string }>> = {};
    const realMatchMedia = window.matchMedia;
    const variants: Record<string, () => void> = {
      base: () => {},
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
    apply();
    out[variant] = {};
    for (const [tab, Page] of Object.entries(pages)) {
      const labels = (adv: boolean) => {
        useSettingsStore.setState({ showAdvancedSettings: adv });
        const { container, unmount } = render(
          <NextIntlClientProvider locale="en" messages={en}>
            <TourProvider>
              <AdvancedSettingsProvider>
                <Page supportsCalendar />
              </AdvancedSettingsProvider>
            </TourProvider>
          </NextIntlClientProvider>,
        );
        const found = Array.from(container.querySelectorAll('[data-search-label]')).map((el) => el.getAttribute('data-search-label') ?? '');
        unmount();
        return found;
      };
      try {
        out[variant][tab] = { on: labels(true), off: labels(false) };
      } catch (e) {
        out[variant][tab] = { on: [], off: [], error: String(e) };
      }
    }
    }
    window.matchMedia = realMatchMedia;

    const problems: string[] = [];
    for (const [tab, entries] of Object.entries(tabSearchEntries)) {
      for (const entry of entries) {
        // Rows that name the app show the stock name, as the index does.
        const text = withAppName(getByPath(en, entry.label), 'Bulwark') as string;
        const variant = out[entry.when ?? 'base'];
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
    expect([...new Set(problems)]).toEqual([]);
  });
});
