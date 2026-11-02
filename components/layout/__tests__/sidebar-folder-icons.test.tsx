import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// #1235: the folder icon follows the JMAP role, not the name. A user folder
// called "Spamhaus" used to get the spam icon because its name contains "spam".

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ isDragging: false }),
}));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({
  useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }),
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));

const { Sidebar } = await import('../sidebar');
const { useSettingsStore } = await import('@/stores/settings-store');

function mailbox(id: string, name: string, role: string | null = null): Mailbox {
  return {
    id, name, role, parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true },
  } as unknown as Mailbox;
}

function iconOf(id: string): string {
  const row = document.querySelector(`[data-mailbox-id="${id}"]`);
  return row?.querySelector('svg')?.getAttribute('data-memail-icon') ?? '';
}

describe('Sidebar folder icons (#1235)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ hideAccountSwitcher: true } as never);
  });

  it('gives user folders that merely contain a system name the plain folder icon', () => {
    render(
      <Sidebar
        mailboxes={[
          mailbox('inbox', 'Inbox', 'inbox'),
          mailbox('spamhaus', 'Spamhaus'),
          mailbox('consent', 'Consent forms'),
        ]}
        selectedMailbox="inbox"
      />,
    );

    expect(iconOf('spamhaus')).toContain('Folder');
    expect(iconOf('spamhaus')).not.toContain('Ban');
    expect(iconOf('consent')).toContain('Folder');
  });

  it('gives the junk folder the spam icon by its role, whatever it is called', () => {
    render(
      <Sidebar
        mailboxes={[mailbox('inbox', 'Inbox', 'inbox'), mailbox('junk', 'Unerwünscht', 'junk')]}
        selectedMailbox="inbox"
      />,
    );

    expect(iconOf('junk')).toContain('Ban');
  });
});
