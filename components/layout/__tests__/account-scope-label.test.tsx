import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactsSidebar } from '@/components/contacts/contacts-sidebar';
import { FilesSidebar, type FilesSidebarProps } from '@/components/files/files-sidebar';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

// pim-p2-11 (2026-11-04): with two accounts, Contacts and Files changed their whole
// list on an account switch with nothing on screen naming the account. Each now shows
// the account's address under its title, and a click there switches.

const switchAccount = vi.fn().mockResolvedValue(undefined);

function renderFiles() {
  const noop = vi.fn();
  const props = {
    currentParentId: null, currentPath: '/', allFolders: [], sharedRoots: [], favorites: [], recentFiles: [],
    canCreate: false,
    onNavigate: noop, onOpenRecent: noop, onUploadFiles: noop, onUploadFolder: noop, onNewFolder: noop,
    onNewTextFile: noop, onToggleFavorite: noop, onDropItems: noop, canShare: () => false, onShare: noop,
    onCreateIn: noop, onRenameFolder: noop, onDeleteFolder: noop, onRevealRecent: noop,
    onDownloadRecent: noop, onRemoveRecent: noop,
  } as unknown as FilesSidebarProps;
  return render(<FilesSidebar {...props} />);
}

function renderContacts() {
  const noop = vi.fn();
  return render(
    <ContactsSidebar
      groups={[]} individuals={[]} addressBooks={[]} activeCategory="all"
      onSelectCategory={noop} onCreateGroup={noop} onCreateContact={noop}
      onEditGroup={noop} onDeleteGroup={noop} onComposeGroup={noop}
    />,
  );
}

const account = (id: string, email: string, isDefault = false) => ({
  id, email, username: email, displayName: 'Same Name', label: 'Same Name', serverUrl: 'https://mail.example.org',
  isDefault, isConnected: true, hasError: false, lastLoginAt: 0, avatarColor: '#888888',
});

describe('the account a screen shows', () => {
  beforeEach(() => {
    switchAccount.mockClear();
    useAccountStore.setState({ accounts: [account('a', 'a@example.org', true), account('b', 'b@example.org')] } as never);
    useAuthStore.setState({ activeAccountId: 'b', switchAccount } as never);
  });
  afterEach(() => {
    cleanup();
    useAccountStore.setState({ accounts: [] } as never);
  });

  for (const [name, renderScreen] of [['Files', renderFiles], ['Contacts', renderContacts]] as const) {
    it(`${name} names the active account by its address and switches from there`, () => {
      renderScreen();
      const label = screen.getByTestId('account-scope');
      expect(label).toHaveTextContent('b@example.org');
      expect(label).not.toHaveTextContent('Same Name');
      act(() => { fireEvent.click(label); });
      const menu = screen.getByRole('menu');
      const options = within(menu).getAllByRole('menuitem');
      expect(options.map((o) => o.textContent)).toEqual(['a@example.org', 'b@example.org']);
      act(() => { fireEvent.click(options[0]); });
      expect(switchAccount).toHaveBeenCalledWith('a');
    });
  }

  it('says nothing with one account', () => {
    useAccountStore.setState({ accounts: [account('b', 'b@example.org', true)] } as never);
    renderFiles();
    expect(screen.queryByTestId('account-scope')).toBeNull();
  });
});
