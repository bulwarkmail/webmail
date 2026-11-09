import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { DirectoryStatus } from '@/stores/contact-store';

// The Directory entry in the Contacts sidebar (#1457): it follows the user's
// setting, and goes away when the server refuses to list its directory.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en/contacts',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/contacts/contact-activity', () => ({ ContactActivity: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => <nav data-testid="rail" /> }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/layout/inline-app-view', () => ({ InlineAppView: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/hooks/use-sidebar-apps', () => ({
  useSidebarApps: () => ({
    showAppsModal: false, inlineApp: null, loadedApps: [], handleManageApps: vi.fn(),
    handleInlineApp: vi.fn(), closeInlineApp: vi.fn(), closeAppsModal: vi.fn(),
  }),
}));

import { ContactsApp } from '../contacts-app';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';
import { useSettingsStore } from '@/stores/settings-store';
import { presettableSetting } from '@/lib/admin/policy-settings';

const CLIENT = { supportsPrincipals: () => true } as unknown as IJMAPClient;

function renderContacts(directoryStatus: DirectoryStatus) {
  act(() => {
    useAuthStore.setState({ isAuthenticated: true, client: CLIENT, isLoading: false });
    useContactStore.setState({
      contacts: [],
      addressBooks: [],
      selectedContactId: null,
      selectedContactIds: new Set(),
      searchQuery: '',
      supportsSync: false,
      contactsLoaded: true,
      directoryPrincipals: [],
      directoryLoaded: true,
      directoryStatus,
    });
  });
  return render(<ContactsApp />);
}

const entry = () => screen.queryByTestId('contacts-directory-entry');

afterEach(() => {
  useSettingsStore.setState({ showContactsDirectory: true });
});

describe('Directory entry in Contacts', () => {
  it('shows when the server lists its directory', () => {
    renderContacts('ready');
    expect(entry()).not.toBeNull();
  });

  it('is hidden when the server refuses to list the directory', () => {
    renderContacts('forbidden');
    expect(entry()).toBeNull();
  });

  it('is hidden when the user turned it off', () => {
    useSettingsStore.setState({ showContactsDirectory: false });
    renderContacts('ready');
    expect(entry()).toBeNull();
  });

  it('leaves the directory view when the entry goes away', () => {
    renderContacts('ready');
    fireEvent.click(entry()!);
    expect(screen.getByRole('button', { name: 'select_page' })).toBeInTheDocument();
    act(() => { useContactStore.setState({ directoryStatus: 'forbidden' }); });
    expect(entry()).toBeNull();
    expect(screen.queryByRole('button', { name: 'select_page' })).toBeNull();
  });

  it('can be preset and locked by the admin policy', () => {
    expect(presettableSetting('showContactsDirectory')).toMatchObject({ type: 'boolean', defaultValue: true });
  });
});
