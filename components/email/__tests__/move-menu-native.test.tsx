import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuSubMenu } from '@/components/ui/context-menu';
import type { BulwarkDesktopBridge, DesktopNativeMenuItem } from '@/lib/desktop/types';
import type { Mailbox } from '@/lib/jmap/types';
import { buildMoveMenu } from '@/lib/move-menu';
import { MoveFolderList } from '../move-target-list';

// The desktop app shows the Move menu natively, read back from the HTML one.
// A native menu can't indent and the account headers used to be plain divs,
// so it showed every account's Inbox, Sent, Spam and Trash in one flat list
// with nothing to tell them apart.

const writable = { mayAddItems: true } as Mailbox['myRights'];
const box = (id: string, name: string, extra: Partial<Mailbox> = {}) =>
  ({
    id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: writable, isSubscribed: true, accountId: 'A', accountName: 'me@example.org', isShared: false, ...extra,
  }) as Mailbox;
const shared = (id: string, name: string, extra: Partial<Mailbox> = {}) =>
  box(`S:${id}`, name, { accountId: 'S', accountName: 'team@example.org', isShared: true, ...extra });

const mailboxes = [
  box('inbox', 'Inbox', { role: 'inbox' }),
  box('trash', 'Trash', { role: 'trash' }),
  box('work', 'Work'),
  box('clients', 'Clients', { parentId: 'work' }),
  box('acme', 'Acme', { parentId: 'clients' }),
  box('rd', 'R&D'),
  shared('inbox', 'Inbox', { role: 'inbox' }),
  shared('trash', 'Trash', { role: 'trash' }),
];

let popup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  popup = vi.fn(() => new Promise<string | null>(() => {}));
  window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: () => {}, popup: popup as never } } as unknown as BulwarkDesktopBridge;
});

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

async function nativeMoveMenu(): Promise<DesktopNativeMenuItem[]> {
  const model = buildMoveMenu(mailboxes, { currentMailboxId: 'inbox', recentIds: () => ['acme'] });
  render(
    <ContextMenu isOpen position={{ x: 10, y: 10 }} onClose={() => {}}>
      <ContextMenuSubMenu label="Move to">
        <MoveFolderList model={model} onPick={() => {}} />
      </ContextMenuSubMenu>
    </ContextMenu>,
  );
  await waitFor(() => expect(popup).toHaveBeenCalled());
  const items = popup.mock.calls[0][0] as DesktopNativeMenuItem[];
  return items[0].submenu!;
}

const labels = (items: DesktopNativeMenuItem[] | undefined) => (items ?? []).map((item) => item.label ?? item.type);

describe('the Move menu shown natively', () => {
  it('has the recent folders under a header, then the account\'s own folders', async () => {
    const move = await nativeMoveMenu();
    expect(labels(move)).toEqual([
      'recent', 'Work / Clients / Acme', 'separator',
      'mailboxes.inbox', 'mailboxes.trash', 'R&D', 'Work',
      'separator', 'team@example.org',
    ]);
    expect(move[0].enabled).toBe(false);
    // The open folder is there, greyed.
    expect(move[3].enabled).toBe(false);
  });

  it('nests subfolders as submenus, the folder itself first', async () => {
    const move = await nativeMoveMenu();
    const work = move.find((item) => item.label === 'Work')!;
    expect(labels(work.submenu)).toEqual(['Work', 'separator', 'Clients']);
    expect(work.submenu![0].id).toBeTruthy();
    const clients = work.submenu![2];
    expect(labels(clients.submenu)).toEqual(['Clients', 'separator', 'Acme']);
  });

  it('puts another account\'s folders in a submenu under its name', async () => {
    const move = await nativeMoveMenu();
    const team = move.find((item) => item.label === 'team@example.org')!;
    expect(labels(team.submenu)).toEqual(['mailboxes.inbox', 'mailboxes.trash']);
  });
});
