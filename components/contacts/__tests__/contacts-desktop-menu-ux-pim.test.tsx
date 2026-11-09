import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';

// pim-15: the desktop app's Edit > Search contacts and File > Import > Contacts…,
// on the whole Contacts app with the shell around it stubbed out.

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
import { requestAppCommand } from '@/lib/app-commands';
import { resetDesktopCommands, runDesktopCommand } from '@/lib/desktop/commands';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';

const alice: ContactCard = {
  id: 'c-alice',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
};

const FAKE_CLIENT = { supportsPrincipals: () => false } as unknown as IJMAPClient;

function renderContacts() {
  act(() => {
    useAuthStore.setState({ isAuthenticated: true, client: FAKE_CLIENT, isLoading: false });
    useContactStore.setState({
      contacts: [alice],
      addressBooks: [],
      selectedContactId: null,
      selectedContactIds: new Set(),
      searchQuery: '',
      supportsSync: false,
      contactsLoaded: true,
    });
  });
  return render(<ContactsApp />);
}

function fakeBridge() {
  const setState = vi.fn();
  window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState, onCommand: () => () => {} } } as unknown as BulwarkDesktopBridge;
  return { setState };
}

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
  resetDesktopCommands();
  act(() => {
    useAuthStore.setState({ isAuthenticated: false, client: null });
    useContactStore.setState({ contacts: [], selectedContactId: null, selectedContactIds: new Set() });
  });
});

describe('Contacts in the desktop menus', () => {
  it('Edit > Search contacts is on offer and puts the cursor in the contacts search', async () => {
    const shell = fakeBridge();
    renderContacts();
    await waitFor(() => expect(shell.setState).toHaveBeenCalled());
    expect(shell.setState.mock.lastCall![0]).toMatchObject({ 'edit.search': true });
    let ran = false;
    act(() => { ran = runDesktopCommand('edit.search'); });
    expect(ran).toBe(true);
    expect(document.activeElement).toBe(screen.getAllByRole('searchbox', { name: 'search_placeholder' })[0]);
  });

  it('File > Import > Contacts… opens the contacts import', () => {
    renderContacts();
    expect(screen.queryByRole('dialog', { name: 'import.title' })).toBeNull();
    let taken = false;
    act(() => { taken = requestAppCommand('import-contacts'); });
    expect(taken).toBe(true);
    expect(screen.getByRole('dialog', { name: 'import.title' })).toBeInTheDocument();
  });
});
