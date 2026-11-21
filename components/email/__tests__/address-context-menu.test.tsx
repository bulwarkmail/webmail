import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactStore } from '@/stores/contact-store';
import { useToastStore } from '@/stores/toast-store';
import { useMailSearchRequests, type MailSearchRequest } from '@/lib/mail-search-request';

// mail-25: a right-click on the sender in a message header did nothing (the
// desktop app showed no menu at all).

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => (values ? `${key} ${JSON.stringify(values)}` : key),
}));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => (email: string) => email }));
const requestInternalMailto = vi.hoisted(() => vi.fn((_href: string) => true));
vi.mock('@/lib/protocol-handlers/mailto', () => ({ requestInternalMailto }));
const added = vi.hoisted(() => vi.fn(async (_email: string, _name?: string) => true));
vi.mock('@/lib/contacts/add-from-address', () => ({ addAddressToContacts: added }));

const { RecipientPopover } = await import('../recipient-popover');

const original = useContactStore.getState();
let writeText: ReturnType<typeof vi.fn>;

function MailPage({ onSearch }: { onSearch: (request: MailSearchRequest) => void }) {
  useMailSearchRequests(onSearch, true);
  return null;
}

function rightClickSender() {
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Sam Lee' }), { clientX: 40, clientY: 30 });
}

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  useContactStore.setState({ contacts: [] });
  useToastStore.getState().clearToasts();
  requestInternalMailto.mockClear();
  added.mockClear();
});

afterEach(() => {
  cleanup();
  useContactStore.setState(original);
});

describe('right-click on an address in a message header', () => {
  it('offers Copy address, New message, Add to contacts and Find emails from', () => {
    render(<><RecipientPopover name="Sam Lee" email="sam@example.org" /><MailPage onSearch={() => {}} /></>);
    rightClickSender();
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual([
      'desktopUi.context.copy_address',
      'email_composer.new_message',
      'email_viewer.contact_sidebar.add_to_contacts',
      'context_menu.find_emails_from {"name":"Sam Lee"}',
    ]);
  });

  it('copies the address', async () => {
    render(<RecipientPopover name="Sam Lee" email="sam@example.org" />);
    rightClickSender();
    fireEvent.click(screen.getByTestId('address-menu-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sam@example.org'));
  });

  it('writes to it in the app\'s composer', () => {
    render(<RecipientPopover name="Sam Lee" email="sam@example.org" />);
    rightClickSender();
    fireEvent.click(screen.getByTestId('address-menu-write'));
    expect(requestInternalMailto).toHaveBeenCalledWith('mailto:sam@example.org');
  });

  it('adds it to the contacts, with the name from the header', async () => {
    render(<RecipientPopover name="Sam Lee" email="sam@example.org" />);
    rightClickSender();
    fireEvent.click(screen.getByTestId('address-menu-contact'));
    await waitFor(() => expect(added).toHaveBeenCalledWith('sam@example.org', 'Sam Lee'));
  });

  it('a saved contact opens instead of being added again', () => {
    useContactStore.setState({ contacts: [{ id: 'c1', emails: { e: { address: 'SAM@example.org' } } }] as never });
    const onViewContact = vi.fn();
    render(<RecipientPopover name="Sam Lee" email="sam@example.org" onViewContact={onViewContact} />);
    rightClickSender();
    expect(screen.getByTestId('address-menu-contact').textContent).toBe('email_viewer.contact_sidebar.view_contact');
    fireEvent.click(screen.getByTestId('address-menu-contact'));
    expect(onViewContact).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'sam@example.org');
    expect(added).not.toHaveBeenCalled();
  });

  it('finds the mail from this sender on the mail page', () => {
    const onSearch = vi.fn();
    render(<><RecipientPopover name="Sam Lee" email="sam@example.org" /><MailPage onSearch={onSearch} /></>);
    rightClickSender();
    act(() => fireEvent.click(screen.getByTestId('address-menu-search')));
    expect(onSearch).toHaveBeenCalledWith({ from: 'sam@example.org' });
  });

  // #1646: the menu stayed open until Escape, a scroll or an item.
  it('closes on a click outside it', async () => {
    render(<><RecipientPopover name="Sam Lee" email="sam@example.org" /><p>Subject</p></>);
    rightClickSender();
    expect(screen.getByRole('menu')).toBeTruthy();
    // The hook starts listening a tick after the menu opened.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.mouseDown(screen.getByText('Subject'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open on a click inside it', async () => {
    render(<RecipientPopover name="Sam Lee" email="sam@example.org" />);
    rightClickSender();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.mouseDown(screen.getByTestId('address-menu-copy'));
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('closes when the reader shows another sender in its place', () => {
    const { rerender } = render(<RecipientPopover name="Sam Lee" email="sam@example.org" />);
    rightClickSender();
    expect(screen.getByRole('menu')).toBeTruthy();
    rerender(<RecipientPopover name="GitHub" email="noreply@github.com" />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('leaves out the search where there is no mail page (a message window)', () => {
    render(<RecipientPopover name="Sam Lee" email="sam@example.org" />);
    rightClickSender();
    expect(screen.queryByTestId('address-menu-search')).toBeNull();
  });
});
