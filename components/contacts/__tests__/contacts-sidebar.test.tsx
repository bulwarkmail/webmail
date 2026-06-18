import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactsSidebar } from '../contacts-sidebar';
import type { ContactCard } from '@/lib/jmap/types';

// next-intl + next/navigation are mocked globally in vitest.setup (t returns the key).
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], activeAccountId: null };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  return { useAccountStore: hook };
});

const group = {
  id: 'g1',
  kind: 'group',
  name: { full: 'Team' },
  members: { '1': true },
} as unknown as ContactCard;

function renderSidebar(onComposeGroup = vi.fn()) {
  render(
    <ContactsSidebar
      groups={[group]}
      individuals={[]}
      addressBooks={[]}
      activeCategory="all"
      onSelectCategory={vi.fn()}
      onCreateGroup={vi.fn()}
      onCreateContact={vi.fn()}
      onEditGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
      onComposeGroup={onComposeGroup}
    />,
  );
  return onComposeGroup;
}

describe('ContactsSidebar — compose to group', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a "Send email to group" submenu in the group context menu', () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('Team'));
    expect(screen.getByText('groups.send_email')).toBeInTheDocument();
    // and the existing Edit/Delete entries still render
    expect(screen.getByText('groups.edit')).toBeInTheDocument();
    expect(screen.getByText('form.delete')).toBeInTheDocument();
  });

  it('calls onComposeGroup(groupId, field) when a To/Cc/Bcc item is clicked', () => {
    const onComposeGroup = renderSidebar();
    fireEvent.contextMenu(screen.getByText('Team'));

    // Open the submenu (hover) then click "Cc".
    const trigger = screen.getByText('groups.send_email').closest('.relative')!;
    fireEvent.mouseOver(trigger);
    fireEvent.mouseEnter(trigger);

    fireEvent.click(screen.getByText('groups.send_email_cc'));
    expect(onComposeGroup).toHaveBeenCalledWith('g1', 'cc');
  });
});
