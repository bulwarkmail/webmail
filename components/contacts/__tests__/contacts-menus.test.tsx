import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContactDetail } from '../contact-detail';
import { ContactGroupDetail } from '../contact-group-detail';
import { ContactList } from '../contact-list';
import type { ContactCard } from '@/lib/jmap/types';

vi.mock('@/components/contacts/contact-activity', () => ({ ContactActivity: () => null }));

const alice: ContactCard = {
  id: '1',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
};

const menuLabels = () => within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);

describe('one action list per contact (R6)', () => {
  it('offers Merge with… in the right-click menu as in the detail ⋮, and no Duplicate', () => {
    const noop = vi.fn();
    render(
      <ContactList
        contacts={[alice]} selectedContactId={null} searchQuery="" onSearchChange={noop} onSelectContact={noop}
        onCreateNew={noop} selectedContactIds={new Set()} onToggleSelection={noop} onSelectRangeContacts={noop}
        onSelectAll={noop} onClearSelection={noop} onBulkDelete={noop} onBulkAddToGroup={noop} onBulkExport={noop}
        onEditContact={noop} onDeleteContact={noop} onAddContactToGroup={noop} onMergeContact={noop} onComposeContact={noop}
      />,
    );
    fireEvent.contextMenu(screen.getByText('Alice'));
    const rightClick = menuLabels();
    expect(rightClick).toContain('merge_with');
    expect(rightClick).not.toContain('context_menu.duplicate');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    render(<ContactDetail contact={alice} onEdit={noop} onDelete={noop} onMergeWith={noop} onAddToGroup={noop} onCompose={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'detail.more_actions' }));
    const detail = menuLabels();
    // The detail's ⋮ is the same list, without what the page has as buttons.
    expect(detail).toEqual(rightClick.filter((l) => !['context_menu.open', 'context_menu.send_email', 'context_menu.edit'].includes(l ?? '')));
  });

  it('says "Edit group" on a group page and keeps Delete in a ⋮ like a contact page', () => {
    const group = { id: 'g', kind: 'group', addressBookIds: {}, name: { full: 'Team' } } as ContactCard;
    const onDelete = vi.fn();
    render(<ContactGroupDetail group={group} members={[]} onEdit={vi.fn()} onDelete={onDelete} onRemoveMember={vi.fn()} onSelectMember={vi.fn()} />);
    expect(screen.getByRole('button', { name: /groups.edit/ })).toBeInTheDocument();
    expect(screen.queryByText('form.edit_title')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'detail.more_actions' }));
    fireEvent.click(screen.getByText('groups.delete'));
    expect(onDelete).toHaveBeenCalled();
  });
});
