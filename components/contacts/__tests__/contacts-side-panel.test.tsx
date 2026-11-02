import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { clearSlotOffers, framePropsOf, offerSlots } from '@/components/plugins/__tests__/fake-slot-offer';
import { setActionDispatcher } from '@/lib/plugin-sandbox/actions';

// The plugin side panel (app-side-panel) in Contacts: a row of its own over
// the contact and the panel, with the open contact's name and the button at
// its end, and the contact in the panel's context.

vi.mock('@/components/plugins/plugin-iframe-slot', () => import('@/components/plugins/__tests__/fake-slot-offer'));
const media = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useIsMobile: () => media.mobile,
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
};

function renderContacts() {
  act(() => {
    useAuthStore.setState({ isAuthenticated: true, client: { supportsPrincipals: () => false } as unknown as IJMAPClient, isLoading: false });
    useContactStore.setState({
      contacts: [alice, bob], addressBooks: [], selectedContactId: null, selectedContactIds: new Set(),
      searchQuery: '', supportsSync: false, contactsLoaded: true,
    });
  });
  return render(<ContactsApp />);
}

afterEach(() => {
  media.mobile = false;
  setActionDispatcher(null);
  clearSlotOffers();
  localStorage.clear();
});

const frame = () => screen.queryByTestId('plugin-frame-app-side-panel');

describe('Contacts side panel', () => {
  it('adds no row without a plugin', () => {
    renderContacts();
    expect(document.querySelector('[data-contacts-panel-row]')).toBeNull();
    expect(document.querySelector('[data-plugin-panel-toggle]')).toBeNull();
  });

  it("puts the open contact's name and the button in an h-14 row over the contact and the panel", () => {
    offerSlots('p1', ['app-side-panel']);
    renderContacts();
    const row = document.querySelector<HTMLElement>('[data-contacts-panel-row]')!;
    expect(row.className).toContain('h-14');
    const toggle = row.querySelector<HTMLElement>('[data-plugin-panel-toggle]')!;
    expect(row.lastElementChild).toBe(toggle);
    expect(toggle).toHaveAccessibleName('plugin_panel');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(framePropsOf(frame()!)).toEqual({ view: 'contacts', context: { selectedCount: 0 }, focusRequest: 0 });
    // The panel is the last thing in the row under it.
    const panel = document.querySelector<HTMLElement>('[data-app-side-panel]')!;
    expect(panel.parentElement!.lastElementChild).toBe(panel);
    expect(row.nextElementSibling).toBe(panel.parentElement);

    fireEvent.click(screen.getByText('Alice Smith'));
    expect(row.firstElementChild).toHaveTextContent('Alice Smith');
    expect(framePropsOf(frame()!).context).toMatchObject({ contact: { id: 'c-alice', fullName: 'Alice Smith', emails: ['alice@example.com'] }, selectedCount: 0 });

    fireEvent.click(toggle);
    expect(frame()).toBeNull();
    // The row and its button stay, so the panel can come back.
    expect(row.querySelector('[data-plugin-panel-toggle]')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps what was typed in a contact form when the panel starts docking', () => {
    renderContacts();
    fireEvent.click(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByRole('button', { name: /detail.edit|edit/ }));
    fireEvent.change(screen.getByPlaceholderText('middle_name'), { target: { value: 'Marie' } });
    const field = screen.getByPlaceholderText('middle_name');
    act(() => offerSlots('p1', ['app-side-panel']));
    expect(document.querySelector('[data-contacts-panel-row]')).not.toBeNull();
    // The same field, with what the user typed.
    expect(field.isConnected).toBe(true);
    expect(screen.getByPlaceholderText('middle_name')).toHaveValue('Marie');
  });

  it('puts the phone button over an open contact, where the list and its header are gone', () => {
    media.mobile = true;
    const dispatch = vi.fn().mockResolvedValue(undefined);
    setActionDispatcher(dispatch);
    offerSlots('p1', ['app-side-panel']);
    renderContacts();
    fireEvent.click(screen.getByText('Alice Smith'));
    const buttons = document.querySelectorAll<HTMLElement>('[data-app-side-panel-phone]');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    const [, surface, action, ctx] = dispatch.mock.calls[0];
    expect([surface, action]).toEqual(['app-side-panel', 'open']);
    expect((ctx as { context: { contact?: { fullName: string } } }).context.contact?.fullName).toBe('Alice Smith');
  });
});
