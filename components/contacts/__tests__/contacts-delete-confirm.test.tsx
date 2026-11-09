import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The delete confirms must name what goes (R3), so this file's t() shows the
// values it was given: "delete_named_title {"name":"Alice Smith"}".
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date | string) => String(d),
    relativeTime: (d: Date | string) => String(d),
    number: (n: number) => String(n),
  }),
}));
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

const alice: ContactCard = {
  id: 'c-alice',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
};
const bob: ContactCard = {
  id: 'c-bob',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Bob' }, { kind: 'surname', value: 'Jones' }], isOrdered: true },
  emails: { e0: { address: 'bob@example.com' } },
};
const team = {
  id: 'g-team',
  kind: 'group',
  addressBookIds: {},
  name: { full: 'Team' },
  members: {},
} as unknown as ContactCard;

const FAKE_CLIENT = { supportsPrincipals: () => false } as unknown as IJMAPClient;

function renderContacts(selected: string[] = []) {
  act(() => {
    useAuthStore.setState({ isAuthenticated: true, client: FAKE_CLIENT, isLoading: false });
    useContactStore.setState({
      contacts: [alice, bob, team],
      addressBooks: [],
      selectedContactId: null,
      selectedContactIds: new Set(selected),
      searchQuery: '',
      supportsSync: false,
      contactsLoaded: true,
    });
  });
  return render(<ContactsApp />);
}

describe('Contacts delete confirms', () => {
  afterEach(() => {
    act(() => {
      useAuthStore.setState({ isAuthenticated: false, client: null });
      useContactStore.setState({ contacts: [], selectedContactId: null, selectedContactIds: new Set() });
    });
  });

  it('names the contact and says what is lost', async () => {
    renderContacts();
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('context_menu.delete'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('delete_named_title {"name":"Alice Smith"}')).toBeInTheDocument();
    expect(within(dialog).getByText('delete_details_message')).toBeInTheDocument();
  });

  it('counts the contacts when several are selected', async () => {
    renderContacts(['c-alice', 'c-bob']);
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByRole('menuitem', { name: /context_menu\.delete/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('bulk.delete_confirm {"count":2}')).toBeInTheDocument();
    expect(within(dialog).getByText('delete_details_message')).toBeInTheDocument();
  });

  it('names the group and says its contacts are kept', async () => {
    renderContacts();
    fireEvent.contextMenu(screen.getAllByText('Team')[0]);
    fireEvent.click(screen.getByText('groups.delete'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('delete_named_title {"name":"Team"}')).toBeInTheDocument();
    expect(within(dialog).getByText('groups.delete_message')).toBeInTheDocument();
  });
});
