import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// pim-p3-7: with several contacts ticked, the right side is about all of them
// (no single contact's card left open), and Send email writes to all of them.

const mailto = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en/contacts',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/protocol-handlers/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  savePendingMailto: mailto.save,
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
import { ContactList } from '../contact-list';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';

const card = (id: string, given: string, email?: string): ContactCard => ({
  id,
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: given }, { kind: 'surname', value: 'Example' }], isOrdered: true },
  ...(email ? { emails: { e0: { address: email } } } : {}),
});
const alice = card('c-alice', 'Alice', 'alice@example.com');
const bob = card('c-bob', 'Bob', 'bob@example.com');
const carol = card('c-carol', 'Carol');

function renderContacts() {
  act(() => {
    useAuthStore.setState({ isAuthenticated: true, client: { supportsPrincipals: () => false } as unknown as IJMAPClient, isLoading: false });
    useContactStore.setState({
      contacts: [alice, bob, carol],
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

beforeEach(() => {
  localStorage.clear();
  mailto.save.mockClear();
});
afterEach(() => {
  act(() => {
    useAuthStore.setState({ isAuthenticated: false, client: null });
    useContactStore.setState({ contacts: [], selectedContactId: null, selectedContactIds: new Set() });
  });
});

describe('several contacts ticked (pim-p3-7)', () => {
  it('replaces the open contact with what can be done with the selection', () => {
    renderContacts();
    fireEvent.click(screen.getByText('Alice Example'));
    // Alice's card is open on the right.
    const side = () => document.querySelector<HTMLElement>('[data-contacts-side-panel-column]')!;
    expect(within(side()).getAllByText('alice@example.com').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText('Bob Example')[0], { ctrlKey: true });
    fireEvent.click(screen.getAllByText('Carol Example')[0], { ctrlKey: true });

    const pane = screen.getByTestId('contact-selection-pane');
    expect(within(pane).getByText('selection_title')).toBeInTheDocument();
    expect(within(pane).getByTestId('contact-selection-names').textContent).toBe('Alice Example, Bob Example, Carol Example');
    // Nothing of Alice's single card is left.
    expect(within(side()).queryByText('alice@example.com')).toBeNull();

    fireEvent.click(within(pane).getByTestId('contact-selection-send'));
    expect(mailto.save).toHaveBeenCalledWith(expect.objectContaining({
      to: ['Alice Example <alice@example.com>', 'Bob Example <bob@example.com>'],
      cc: [],
      bcc: [],
    }));

    fireEvent.click(within(pane).getByTestId('contact-selection-clear'));
    expect(screen.queryByTestId('contact-selection-pane')).toBeNull();
  });

  it('offers Send email in the menu for several, with the single menu\'s words and Del', () => {
    const noop = vi.fn();
    const compose = vi.fn();
    render(
      <ContactList
        contacts={[alice, bob]} selectedContactId={null} searchQuery="" onSearchChange={noop} onSelectContact={noop}
        onCreateNew={noop} selectedContactIds={new Set(['c-alice', 'c-bob'])} onToggleSelection={noop} onSelectRangeContacts={noop}
        onSelectAll={noop} onClearSelection={noop} onBulkDelete={noop} onBulkAddToGroup={noop} onBulkExport={noop}
        onEditContact={noop} onDeleteContact={noop} onAddContactToGroup={noop} onComposeContact={noop} onBulkCompose={compose}
      />,
    );
    fireEvent.contextMenu(screen.getAllByText('Alice Example')[0]);
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    const labels = items.map((i) => i.textContent ?? '');
    expect(labels[0]).toBe('context_menu.send_email');
    expect(labels.some((l) => l.startsWith('context_menu.export_vcard'))).toBe(true);
    const del = items.find((i) => i.textContent?.startsWith('context_menu.delete'));
    expect(del?.textContent).toContain('Del');
    fireEvent.click(items[0]);
    expect(compose).toHaveBeenCalled();
  });
});
