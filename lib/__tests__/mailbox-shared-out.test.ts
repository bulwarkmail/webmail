import { describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '../jmap/client-interface';
import { isSharedOut } from '../mailbox-shared-out';

const boxes = [
  { id: 'arch' },
  { id: '2026', parentId: 'arch' },
  { id: 'inbox' },
];
const client = (shares: Record<string, unknown>, sharing = true) => ({
  supportsMailboxSharing: () => sharing,
  getMailboxShareWith: vi.fn(async (id: string) => shares[id] ?? null),
}) as unknown as IJMAPClient;

describe('isSharedOut', () => {
  it('asks the server for the folder and, when asked to, the folders below it', async () => {
    const c = client({ '2026': { u2: { mayReadItems: true } } });
    expect(await isSharedOut(c, boxes, 'arch')).toBe(false);
    expect(await isSharedOut(c, boxes, 'arch', undefined, { descendants: true })).toBe(true);
  });

  it('is false only where nothing is shared or the server has no sharing', async () => {
    expect(await isSharedOut(client({}), boxes, 'inbox')).toBe(false);
    expect(await isSharedOut(client({ inbox: { u2: {} } }, false), boxes, 'inbox')).toBe(false);
    expect(await isSharedOut({ supportsMailboxSharing: () => true } as unknown as IJMAPClient, boxes, 'inbox')).toBe(true);
  });
});
