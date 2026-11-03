import { describe, expect, it } from 'vitest';
import { parseMailPath, resolveFolderRef } from '@/lib/deep-links';
import type { Mailbox } from '@/lib/jmap/types';
import { pushClick } from './helpers/push-click';

const folders = [
  { id: 'a', name: 'Inbox', role: 'inbox', accountId: 'personal', totalEmails: 0, unreadEmails: 0 },
  { id: 'team:a', originalId: 'a', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'team', totalEmails: 0, unreadEmails: 0 },
] as Mailbox[];

function parseTarget(target: string) {
  const url = new URL(target, 'https://mail.example.test');
  return parseMailPath(url.pathname.split('/mail/')[1].split('/'), url.searchParams);
}

describe('push click keeps the owning mailbox (#1491)', () => {
  for (const owner of ['personal', 'team']) {
    for (const unreadTotal of [1, 3]) {
      for (const warm of [false, true]) {
        it(`${owner}, ${unreadTotal} unread, ${warm ? 'existing' : 'new'} window`, async () => {
          const target = await pushClick(owner, async (url) => {
            expect(new URL(url, 'https://mail.example.test').searchParams.get('accountId')).toBe(owner);
            return { slot: 0, unreadTotal, email: { id: 'same-id', threadId: 't', subject: 'Mail' } };
          }, { warm });
          const link = parseTarget(target);
          expect(link?.slot).toBe(0);
          if (unreadTotal === 1) {
            expect(link).toMatchObject({ kind: 'message', id: 'same-id', ownerAccountId: owner });
          } else {
            expect(link).toMatchObject({ kind: 'folder', ref: 'inbox', ownerAccountId: owner });
            if (link?.kind !== 'folder') throw new Error('Expected folder link');
            expect(resolveFolderRef(link.ref, folders, link.ownerAccountId)).toBe(owner === 'team' ? 'team:a' : 'a');
          }
        });
      }
    }
  }

  it('keeps the owner when organisation policy hides message details', async () => {
    const target = await pushClick('team', async () => ({ slot: 2, unreadTotal: 1, redacted: true, email: { id: 'same-id' } }));
    expect(parseTarget(target)).toMatchObject({ kind: 'message', ownerAccountId: 'team', slot: 2 });
  });

  it('keeps the login slot and owner with a mount prefix and legacy payload', async () => {
    const target = await pushClick('team', async () => ({ slot: 2, unreadTotal: 3, email: { id: 'same-id' } }), { basePath: '/webmail', legacy: true });
    expect(target).toMatch(/^\/webmail\/mail\/folder\/inbox\?/);
    expect(parseTarget(target)).toMatchObject({ kind: 'folder', ownerAccountId: 'team', slot: 2 });
  });

  it('keeps the slot and owner where URLSearchParams has no size', async () => {
    const target = await pushClick('team', async () => ({ slot: 1, unreadTotal: 1, email: { id: 'same-id' } }), { noParamsSize: true });
    expect(parseTarget(target)).toMatchObject({ kind: 'message', ownerAccountId: 'team', slot: 1 });
  });

  it('does not fall back to a personal folder for an unavailable owner', () => {
    expect(resolveFolderRef('inbox', folders, 'unavailable')).toBeNull();
  });

  it('keeps old unscoped folder links working', () => {
    expect(resolveFolderRef('inbox', folders)).toBe('a');
  });
});
