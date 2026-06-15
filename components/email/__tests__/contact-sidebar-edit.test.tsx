import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactSidebarPanel } from '../email-viewer';
import type { ContactCard } from '@/lib/jmap/types';

const contact: ContactCard = {
  id: 'c1',
  addressBookIds: {},
  name: {
    components: [
      { kind: 'given', value: 'Alice' },
      { kind: 'surname', value: 'Smith' },
    ],
    isOrdered: true,
  },
  emails: { e0: { address: 'alice@example.com' } },
};

const unknownEmail = 'unknown@example.com';

describe('ContactSidebarPanel', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('shows Edit button when contact is known and onEditContact is provided', () => {
    render(
      <ContactSidebarPanel
        email="alice@example.com"
        contact={contact}
        onClose={vi.fn()}
        onEditContact={vi.fn()}
      />,
    );
    // useTranslations mock returns the key, so we look for the common.edit key
    expect(screen.getByTitle('contact_sidebar.action_edit_title')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
  });

  it('calls onEditContact when Edit button is clicked', () => {
    const onEditContact = vi.fn();
    render(
      <ContactSidebarPanel
        email="alice@example.com"
        contact={contact}
        onClose={vi.fn()}
        onEditContact={onEditContact}
      />,
    );
    fireEvent.click(screen.getByTitle('contact_sidebar.action_edit_title'));
    expect(onEditContact).toHaveBeenCalledOnce();
  });

  it('does not show Edit button when contact is null', () => {
    render(
      <ContactSidebarPanel
        email={unknownEmail}
        contact={null}
        onClose={vi.fn()}
        onEditContact={vi.fn()}
      />,
    );
    expect(screen.queryByTitle('contact_sidebar.action_edit_title')).not.toBeInTheDocument();
  });

  it('does not show Edit button when onEditContact is not provided', () => {
    render(
      <ContactSidebarPanel
        email="alice@example.com"
        contact={contact}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTitle('contact_sidebar.action_edit_title')).not.toBeInTheDocument();
  });

  it('shows "not in contacts" message and Add button for unknown email', () => {
    const onAddToContacts = vi.fn();
    render(
      <ContactSidebarPanel
        email={unknownEmail}
        contact={null}
        onClose={vi.fn()}
        onAddToContacts={onAddToContacts}
      />,
    );
    expect(screen.getByText('contact_sidebar.not_in_contacts')).toBeInTheDocument();
    fireEvent.click(screen.getByText('contact_sidebar.add_to_contacts'));
    expect(onAddToContacts).toHaveBeenCalledWith(unknownEmail, undefined);
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <ContactSidebarPanel
        email="alice@example.com"
        contact={contact}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('contact_sidebar.close'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
