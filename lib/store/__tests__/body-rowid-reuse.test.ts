// @vitest-environment node
import { expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { mailArea } from '../mail';
import { deleteEmail, storeBody, upsertEmail } from '../mail/records';
import { FAKE_SESSION, FakeJmap, JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

// SQLite hands a deleted row's rowid to the next insert. A body that was on
// its way for a message deleted meanwhile must not land on the new message
// that took its rowid.
it('a body for a deleted message is not stored on the new message that took its rowid', async () => {
  const server = new FakeJmap();
  for (let i = 0; i < 5; i += 1) server.addEmail({ subject: `Server ${i}` });
  const db = openMemoryStore();
  const request = server.request.bind(server);
  let reused: { deleted: number; draft: number } | null = null;
  server.request = async (calls) => {
    const response = await request(calls);
    if (calls[0][1].fetchAllBodyValues && !reused) {
      const newest = db.get<{ rowid: number; id: string }>('SELECT rowid, id FROM email ORDER BY rowid DESC LIMIT 1')!;
      deleteEmail(db, JMAP_ACCOUNT, newest.id);
      const list = { id: 'draft1', threadId: 'td', mailboxIds: { drafts: true }, keywords: { $draft: true }, receivedAt: '2026-11-01T00:00:00Z', subject: 'My draft', size: 10 };
      const rowid = upsertEmail(db, JMAP_ACCOUNT, list as never, 0);
      storeBody(db, rowid, JSON.stringify(list), { textBody: [{ partId: '1' }], bodyValues: { '1': { value: 'MY DRAFT TEXT' } } });
      reused = { deleted: Number(newest.rowid), draft: Number(rowid) };
    }
    return response;
  };
  await new AccountEngine({
    account: 'a@fake.test', db, session: FAKE_SESSION, transport: server, areas: [mailArea],
    scope: { ...DEFAULT_SCOPE, days: null, attachments: false }, now: () => Date.UTC(2026, 10, 3), sleep: async () => {},
  }).requestSync();
  // The setup only means something when the draft really took the deleted rowid.
  expect(reused).not.toBeNull();
  expect(reused!.draft).toBe(reused!.deleted);
  const body = db.get<{ json: string }>('SELECT json FROM email_body WHERE email_rowid = ?', [reused!.draft])!;
  expect(body.json).toContain('MY DRAFT TEXT');
});
