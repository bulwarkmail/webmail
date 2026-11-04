import { afterEach, describe, expect, it } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { rememberTrashOrigins, restoreTarget, restoreTargetForAll } from '../trash-origin';

const mailboxes = [
  { id: 'inbox', role: 'inbox', myRights: { mayAddItems: true } },
  { id: 'work', role: null, myRights: { mayAddItems: true } },
  { id: 'trash', role: 'trash', myRights: { mayAddItems: true } },
  { id: 'team:inbox', role: 'inbox', isShared: true, accountId: 'team', myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

afterEach(() => localStorage.clear());

describe('where Restore puts a message', () => {
  it('back in the folder it went to Trash from', () => {
    rememberTrashOrigins([{ id: 'e1', mailboxIds: { work: true } }], mailboxes);
    expect(restoreTarget({ id: 'e1', mailboxIds: { trash: true } }, mailboxes, 'trash')).toBe('work');
  });

  it('the Inbox when nothing was noted, or the folder is gone', () => {
    expect(restoreTarget({ id: 'e2', mailboxIds: { trash: true } }, mailboxes, 'trash')).toBe('inbox');
    rememberTrashOrigins([{ id: 'e3', mailboxIds: { gone: true } }], mailboxes);
    expect(restoreTarget({ id: 'e3', mailboxIds: { trash: true } }, mailboxes, 'trash')).toBe('inbox');
  });

  it('a shared account\'s message goes to that account\'s Inbox', () => {
    expect(restoreTarget({ id: 'e4', sourceAccountId: 'team', mailboxIds: {} }, mailboxes, 'trash')).toBe('team:inbox');
  });

  it('several: where they all came from, or the Inbox when that differs', () => {
    rememberTrashOrigins([{ id: 'a', mailboxIds: { work: true } }, { id: 'b', mailboxIds: { work: true } }], mailboxes);
    expect(restoreTargetForAll([{ id: 'a', mailboxIds: {} }, { id: 'b', mailboxIds: {} }], mailboxes, 'trash')).toBe('work');
    expect(restoreTargetForAll([{ id: 'a', mailboxIds: {} }, { id: 'c', mailboxIds: {} }], mailboxes, 'trash')).toBe('inbox');
  });

  it('Trash itself is never noted as where a message came from', () => {
    rememberTrashOrigins([{ id: 'e5', mailboxIds: { trash: true } }], mailboxes);
    expect(localStorage.getItem('bulwark.trashOrigin.v1')).toBeNull();
  });
});
