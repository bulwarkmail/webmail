import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContactDetail } from '../contact-detail';
import { exportContacts } from '../contact-export';
import type { ContactCard } from '@/lib/jmap/types';
import type { BlobBatch } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';
import { clearContactPhotoCache } from '@/lib/contact-photo-cache';
import { contactHooks, clearAllHooks } from '@/lib/plugin-hooks';

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

const contact: ContactCard = {
  id: '1',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
  phones: { p0: { number: '+33612345678' } },
  organizations: { o0: { name: 'Acme Corp' } },
  addresses: { a0: { street: '123 Main St', locality: 'Paris', country: 'France' } },
  notes: { n0: { note: 'VIP customer' } },
};

describe('ContactDetail', () => {
  it('shows empty state when contact is null', () => {
    render(<ContactDetail contact={null} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('detail.no_contact_selected')).toBeInTheDocument();
  });

  it('displays the contact name', () => {
    render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('displays email addresses as mailto links', () => {
    render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
    const link = screen.getByText('alice@example.com');
    expect(link.closest('a')).toHaveAttribute('href', 'mailto:alice@example.com');
  });

  it('shows the copy and compose buttons on keyboard focus and touch, not only on hover', () => {
    render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
    const copy = screen.getByRole('button', { name: 'detail.copy_email' });
    const actions = copy.closest('[data-row-actions]') as HTMLElement;
    expect(actions.className).toContain('group-focus-within:opacity-100');
    expect(actions.className).toContain('pointer-coarse:opacity-100');
  });

  it('displays phone numbers', () => {
    render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('+33612345678')).toBeInTheDocument();
  });

  it('labels phones, emails and addresses with translated contexts and phone types', () => {
    const typed: ContactCard = {
      ...contact,
      emails: { e0: { address: 'alice@work.example', contexts: { work: true } } },
      phones: { p0: { number: '+4930123', contexts: { private: true }, features: { cell: true, 'x-sat': true } } },
      addresses: { a0: { street: '1 Office Rd', contexts: { work: true, 'x-hq': true } } },
    };
    render(<ContactDetail contact={typed} onEdit={vi.fn()} onDelete={vi.fn()} />);
    // The test translator returns the key, so a translated label shows up as its key.
    expect(screen.getByText('form.context_work')).toBeInTheDocument();
    expect(screen.getByText('ux_pim_contact.context_private · form.phone_cell, x-sat')).toBeInTheDocument();
    // Custom vCard types are shown as stored.
    expect(screen.getByText('form.context_work, x-hq')).toBeInTheDocument();
  });

  it('displays organization name', () => {
    render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
    const matches = screen.getAllByText('Acme Corp');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('calls onEdit when edit button is clicked', () => {
    const onEdit = vi.fn();
    render(<ContactDetail contact={contact} onEdit={onEdit} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByText('form.edit_title'));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it('calls onDelete when delete button is clicked', () => {
    const onDelete = vi.fn();
    render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText('detail.more_actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: /context_menu\.delete/ }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  describe('photo', () => {
    const fetchBlob = vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }));

    beforeEach(() => {
      clearContactPhotoCache();
      fetchBlob.mockClear();
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:photo');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      // ContactActivity asks the same client for mail and events.
      useAuthStore.setState({
        client: {
          fetchBlob,
          advancedSearchEmails: vi.fn(async () => ({ emails: [] })),
          queryAllCalendarEvents: vi.fn(async () => []),
        } as never,
      });
    });

    afterEach(() => {
      useAuthStore.setState({ client: null });
      useContactStore.setState({ contacts: [] });
      clearContactPhotoCache();
      vi.restoreAllMocks();
    });

    it('shows the photo of a Stalwart 1.0 card', async () => {
      const { container } = render(
        <ContactDetail
          contact={{ ...contact, accountId: 'a', media: { photo: { kind: 'photo', blobId: 'dbcX', mediaType: 'image/jpeg' } } }}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:photo'));
      expect(fetchBlob).toHaveBeenCalledWith('dbcX', 'photo', 'image/jpeg', 'a');
    });

    it('greys out "Export as vCard" while an export runs', async () => {
      let deliver!: (batch: BlobBatch) => void;
      useAuthStore.setState({
        client: {
          ...(useAuthStore.getState().client as object),
          getContactsAccountId: () => 'a',
          getBlobsAsBase64: () => new Promise<BlobBatch>((resolve) => { deliver = resolve; }),
        } as never,
      });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
      let running!: Promise<boolean>;
      act(() => { running = exportContacts([{ ...contact, media: { photo: { kind: 'photo', blobId: 'dbcX' } } }]); });

      fireEvent.click(screen.getByLabelText('detail.more_actions'));
      expect(screen.getByRole('menuitem', { name: /context_menu\.export_vcard/ })).toBeDisabled();

      await act(async () => {
        deliver({ data: new Map([['dbcX', '/9j/']]), failed: [] });
        await running;
      });
      expect(screen.getByRole('menuitem', { name: /context_menu\.export_vcard/ })).not.toBeDisabled();
    });

    it('does not show another card\'s photo for the same address', () => {
      useContactStore.setState({
        contacts: [{ ...contact, id: '2', media: { photo: { kind: 'photo', blobId: 'dbcOther' } } }],
      });
      const { container } = render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
      expect(container.querySelector('img')).toBeNull();
      expect(fetchBlob).not.toHaveBeenCalled();
    });
  });
});

describe('ContactDetail plugin hooks', () => {
  beforeEach(() => clearAllHooks());

  it('tells plugins once when a contact is opened, again for another one', async () => {
    const opened = vi.fn();
    contactHooks.onContactOpen.register('test', opened);

    const { rerender } = render(<ContactDetail contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
    // Same contact with changed data: still the same open contact.
    rerender(<ContactDetail contact={{ ...contact, notes: {} }} onEdit={vi.fn()} onDelete={vi.fn()} />);
    rerender(<ContactDetail contact={{ ...contact, id: '2' }} onEdit={vi.fn()} onDelete={vi.fn()} />);
    rerender(<ContactDetail contact={null} onEdit={vi.fn()} onDelete={vi.fn()} />);
    await Promise.resolve();

    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened.mock.calls[0][0]).toMatchObject({ id: '1', fullName: 'Alice Smith', emails: ['alice@example.com'] });
    expect(opened.mock.calls[1][0]).toMatchObject({ id: '2' });
  });
});
