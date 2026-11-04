import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The whole Contacts app in local mode (no JMAP client): the stores hold the
// contacts, and the shell around it is stubbed out.

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
import { useRegisteredCommandGroups, type CommandGroup } from '@/lib/command-registry';

/** The palette's command groups as the palette would read them now. */
function getRegisteredGroups(): CommandGroup[] {
  let groups: CommandGroup[] = [];
  function Probe() {
    groups = useRegisteredCommandGroups();
    return null;
  }
  const { unmount } = render(<Probe />);
  unmount();
  return groups;
}
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';
import { useToastStore } from '@/stores/toast-store';
import { interceptLeave } from '@/lib/leave-guard';

export const alice: ContactCard = {
  id: 'c-alice',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
};
export const bob: ContactCard = {
  id: 'c-bob',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Bob' }, { kind: 'surname', value: 'Jones' }], isOrdered: true },
  emails: { e0: { address: 'bob@example.com' } },
};

// Only asked whether the server has a directory; supportsSync stays false.
const FAKE_CLIENT = {
  supportsPrincipals: () => false,
} as unknown as IJMAPClient;

export function renderContacts(contacts: ContactCard[] = [alice, bob]) {
  act(() => {
    useAuthStore.setState({ isAuthenticated: true, client: FAKE_CLIENT, isLoading: false });
    useContactStore.setState({
      contacts,
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

/** The categories drawer of a narrow window (jsdom matches no media query). */
function drawer() {
  return screen.getByTestId('contacts-sidebar-drawer');
}

describe('ContactsApp', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    act(() => {
      useAuthStore.setState({ isAuthenticated: false, client: null });
      useContactStore.setState({ contacts: [], selectedContactId: null, selectedContactIds: new Set() });
    });
  });

  it("takes the closed drawer out of reach, so it can't cover the nav rail or catch Tab", () => {
    renderContacts();
    expect(drawer()).toHaveAttribute('inert');
    expect(drawer().className).toContain('invisible');

    fireEvent.click(screen.getAllByRole('button', { name: 'open_categories' })[0]);
    expect(drawer()).not.toHaveAttribute('inert');
    expect(within(drawer()).getByText('tabs.all')).toBeInTheDocument();
  });

  it("closes the drawer when something in it is picked, so it doesn't stay over the form", () => {
    renderContacts();
    fireEvent.click(screen.getAllByRole('button', { name: 'open_categories' })[0]);
    expect(drawer()).not.toHaveAttribute('inert');

    // The header's "+" menu, then "New contact".
    fireEvent.click(within(drawer()).getByRole('button', { name: 'new' }));
    fireEvent.click(screen.getByText('create_new'));
    expect(drawer()).toHaveAttribute('inert');
  });

  it('asks before another contact replaces a contact form with changes, and keeps them on "Keep editing"', async () => {
    renderContacts();
    fireEvent.click(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByRole('button', { name: /detail.edit|edit/ }));
    fireEvent.change(screen.getByPlaceholderText('middle_name'), { target: { value: 'Marie' } });

    fireEvent.click(screen.getByText('Bob Jones'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('form.discard_title')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'form.keep_editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByPlaceholderText('middle_name')).toHaveValue('Marie');

    fireEvent.click(screen.getByText('Bob Jones'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'form.discard' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('middle_name')).toBeNull());
    expect(useContactStore.getState().selectedContactId).toBe('c-bob');
  });

  it('adds the open contact to the selection on Ctrl+click, as Files does', () => {
    renderContacts();
    fireEvent.click(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('Bob Jones'), { ctrlKey: true });
    expect([...useContactStore.getState().selectedContactIds].sort()).toEqual(['c-alice', 'c-bob']);
  });

  it('selects from the open contact on Shift+click', () => {
    const carol: ContactCard = { ...bob, id: 'c-carol', name: { full: 'Carol King' }, emails: { e0: { address: 'carol@example.com' } } };
    renderContacts([alice, bob, carol]);
    fireEvent.click(screen.getByText('Bob Jones'));
    fireEvent.click(screen.getByText('Carol King'), { shiftKey: true });
    expect([...useContactStore.getState().selectedContactIds].sort()).toEqual(['c-bob', 'c-carol']);
  });

  it('has the rail and tab bar ask before they leave a contact form with changes', async () => {
    renderContacts();
    fireEvent.click(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByRole('button', { name: /detail.edit|edit/ }));
    fireEvent.change(screen.getByPlaceholderText('middle_name'), { target: { value: 'Marie' } });

    // A rail link wired as the real one is: interceptLeave first.
    const navigated = vi.fn();
    const link = document.createElement('a');
    link.addEventListener('click', (e) => { if (!interceptLeave(e)) navigated(); });
    document.body.appendChild(link);
    try {
      act(() => { link.click(); });
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText('form.discard_title')).toBeInTheDocument();
      expect(navigated).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'form.discard' }));
      await waitFor(() => expect(navigated).toHaveBeenCalledOnce());
    } finally {
      link.remove();
    }
  });

  it('leaves an untouched contact form without asking', () => {
    renderContacts();
    fireEvent.click(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByRole('button', { name: /detail.edit|edit/ }));
    fireEvent.click(screen.getByText('Bob Jones'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useContactStore.getState().selectedContactId).toBe('c-bob');
  });

  it('starts a new group with the contact when "Add to group" finds no group to add to', () => {
    renderContacts();
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('contacts_add_to_group'));
    expect(screen.getByText('groups.members_label (1)')).toBeInTheDocument();
  });

  it('offers a new group, with the selection in it, next to the existing groups', () => {
    const team: ContactCard = { id: 'g-team', kind: 'group', addressBookIds: {}, name: { full: 'Team' }, members: {} };
    renderContacts([alice, bob, team]);
    fireEvent.contextMenu(screen.getByText('Bob Jones'));
    fireEvent.click(screen.getByText('contacts_add_to_group'));
    fireEvent.click(screen.getByText('bulk.new_group'));
    expect(screen.getByText('groups.members_label (1)')).toBeInTheDocument();
  });

  it('offers no Edit, Move or Delete for a contact in an address book shared read-only', () => {
    const shared = { ...alice, addressBookIds: { 'ab-shared': true } };
    renderContacts([shared, bob]);
    act(() => {
      useContactStore.setState({ addressBooks: [{ id: 'ab-shared', name: 'Team', myRights: { mayRead: true, mayWrite: false } }] as never });
    });
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    expect(screen.queryByRole('menuitem', { name: 'context_menu.edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /context_menu.delete/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'context_menu.export_vcard' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.contextMenu(screen.getByText('Bob Jones'));
    expect(screen.getByRole('menuitem', { name: 'context_menu.edit' })).toBeInTheDocument();
  });

  it('imports in a real dialog that Escape closes', () => {
    renderContacts();
    fireEvent.click(screen.getAllByRole('button', { name: 'open_categories' })[0]);
    fireEvent.click(within(drawer()).getByRole('button', { name: 'new' }));
    fireEvent.click(screen.getByText('import_menu'));
    const dialog = screen.getByRole('dialog', { name: 'import.title' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'import.title' })).toBeNull();
  });

  it('deletes a category without asking and brings it back on Undo', async () => {
    const tagged = { ...alice, keywords: { Friends: true } };
    renderContacts([tagged, bob]);
    fireEvent.click(screen.getAllByRole('button', { name: 'open_categories' })[0]);
    fireEvent.click(within(drawer()).getByRole('button', { name: 'row_actions' }));
    fireEvent.click(screen.getByText('delete_category'));

    await waitFor(() => expect(useContactStore.getState().contacts.find((c) => c.id === 'c-alice')?.keywords?.Friends).toBeUndefined());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const toastState = useToastStore.getState().toasts.at(-1)!;
    expect(toastState.title).toBe('category_deleted');
    await act(async () => { toastState.action!.onClick(); });
    await waitFor(() => expect(useContactStore.getState().contacts.find((c) => c.id === 'c-alice')?.keywords?.Friends).toBe(true));
  });

  it('has a create button on the phone, as Mail and Files do', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: query.includes('width <') })) as typeof window.matchMedia;
    try {
      renderContacts();
      fireEvent.click(screen.getByRole('button', { name: 'create_new' }));
      expect(screen.getByPlaceholderText('middle_name')).toBeInTheDocument();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('shows a new contact once it is saved, instead of an empty pane', async () => {
    renderContacts();
    fireEvent.click(screen.getAllByRole('button', { name: 'open_categories' })[0]);
    fireEvent.click(within(drawer()).getByRole('button', { name: 'new' }));
    fireEvent.click(screen.getByText('create_new'));
    fireEvent.change(screen.getByPlaceholderText('given_name'), { target: { value: 'Zed' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Zed' })).toBeInTheDocument());
  });

  it('adds New contact, Import and New group to the command palette while open', () => {
    renderContacts();
    const groups = getRegisteredGroups();
    const contacts = groups.find((g) => g.label === 'contacts');
    expect(contacts?.commands.map((c) => c.label)).toEqual(expect.arrayContaining(['create_new', 'import.title', 'groups.create']));
    act(() => { contacts!.commands.find((c) => c.id === 'new-contact')!.run(); });
    expect(screen.getByPlaceholderText('middle_name')).toBeInTheDocument();
  });

  it('puts New group and Import in the phone header menu', () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: query.includes('width <') })) as typeof window.matchMedia;
    try {
      renderContacts();
      fireEvent.click(screen.getByRole('button', { name: 'more' }));
      fireEvent.click(screen.getByText('import_menu'));
      expect(screen.getByRole('dialog', { name: 'import.title' })).toBeInTheDocument();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('says an empty address book is empty, not that the account has no contacts, and offers Import', () => {
    renderContacts([alice]);
    act(() => { useContactStore.setState({ addressBooks: [{ id: 'b2', name: 'Work', isDefault: false } as never] }); });
    fireEvent.click(screen.getAllByRole('button', { name: 'open_categories' })[0]);
    fireEvent.click(within(drawer()).getByText('Work'));
    expect(screen.getByText('empty_view_title')).toBeInTheDocument();
    expect(screen.queryByText('empty_state_title')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /import_menu/ }));
    expect(screen.getByRole('dialog', { name: 'import.title' })).toBeInTheDocument();
  });

  it("marks a message started from Contacts as the app's own, so Mail does not ask for an account", async () => {
    const { consumePendingMailto } = await import('@/lib/protocol-handlers/session');
    renderContacts();
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('context_menu.send_email'));
    expect(consumePendingMailto()).toMatchObject({ to: [expect.stringContaining('alice@example.com')], inApp: true });
  });

  it('says so when a duplicate fails', async () => {
    renderContacts();
    const addLocalContact = vi.fn(async () => { throw new Error('quota'); });
    act(() => { useContactStore.setState({ addLocalContact }); });
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('context_menu.duplicate'));
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('toast.error_create'));
  });

  it("marks no member in the list on a group's page, even with a contact open before", () => {
    const team: ContactCard = { id: 'g-team', addressBookIds: {}, kind: 'group', name: { full: 'Team' }, members: { 'c-alice': true, 'c-bob': true } };
    renderContacts([alice, bob, team]);
    fireEvent.click(screen.getByText('Alice Smith'));
    expect(document.querySelector('[data-contact-id="c-alice"]')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: 'open_categories' })[0]);
    fireEvent.click(within(drawer()).getByText('Team'));
    expect(screen.getByText('groups.members_label')).toBeInTheDocument();
    expect(document.querySelector('[data-contact-id="c-alice"]')).toHaveAttribute('aria-selected', 'false');
    expect(document.querySelectorAll('[data-contact-id][aria-selected="true"]')).toHaveLength(0);
  });
});
