import { describe, it, expect } from 'vitest';
import { DemoJMAPClient } from '../demo-client';
import { SMB, SUPPORT_ACCOUNT_ID } from '../fixtures/mailboxes';
import { NOTE_INDEX_PROPERTIES, noteKeyFor, parseNote } from '@/lib/team-mailboxes/note-format';
import { isTeamNotesFolder } from '@/lib/team-mailboxes/hidden-folders';

// The team mailbox screenshots read these notes the way the store does: the
// index from queryTeamNotes, the texts from getTeamNotes.

async function index(client: DemoJMAPClient) {
  const filter = { operator: 'AND', conditions: [{ inMailbox: SMB.notes }, { after: new Date(Date.now() - 90 * 86_400_000).toISOString() }] };
  const page = await client.queryTeamNotes(SUPPORT_ACCOUNT_ID, filter, { limit: 100, properties: NOTE_INDEX_PROPERTIES });
  return page.list.map((raw) => parseNote(raw)).filter((n) => n !== null);
}

describe('demo team notes', () => {
  it('names the Support account by its address, as Stalwart names group accounts', () => {
    const client = new DemoJMAPClient('work');
    expect(client.getAccountInfo(SUPPORT_ACCOUNT_ID)).toMatchObject({ name: 'support@meridianlabs.example', isPersonal: false });
    expect(new DemoJMAPClient('personal').getAccountInfo(SUPPORT_ACCOUNT_ID)).toBeNull();
  });

  it('keeps the Team notes folder out of every folder list', async () => {
    const client = new DemoJMAPClient('work');
    const all = await client.getMailboxes(SUPPORT_ACCOUNT_ID, { includeHidden: true });
    expect(all.filter((m) => isTeamNotesFolder(m, false)).map((m) => m.id)).toEqual([SMB.notes]);
    expect((await client.getMailboxes(SUPPORT_ACCOUNT_ID)).map((m) => m.id)).not.toContain(SMB.notes);
    expect((await client.getAllMailboxes()).map((m) => m.originalId ?? m.id)).not.toContain(SMB.notes);
  });

  it('hands the notes back newest first, each about a message in the Support mailbox', async () => {
    const client = new DemoJMAPClient('work');
    const notes = await index(client);
    expect(notes.length).toBe(6);
    expect(notes.map((n) => n.at)).toEqual([...notes.map((n) => n.at)].sort((a, b) => b - a));
    const { emails } = await client.getEmails(SMB.inbox, SUPPORT_ACCOUNT_ID, 50);
    const keys = new Set(emails.map((e) => noteKeyFor(e, SUPPORT_ACCOUNT_ID)));
    for (const note of notes) expect(keys).toContain(note.key);
    const tomas = emails.find((e) => e.id === 'demo-support-tomas')!;
    const mention = notes.find((n) => n.kind === 'note' && n.key === noteKeyFor(tomas, SUPPORT_ACCOUNT_ID) && n.mentions.length > 0);
    expect(mention).toMatchObject({ author: { email: 'bob.chen@meridianlabs.example', id: 'demo-bob' }, mentions: ['demo-account'] });
  });

  it('gives the texts on request and keeps a note written in the demo until it is deleted', async () => {
    const client = new DemoJMAPClient('work');
    const [first] = await index(client);
    const { list } = await client.getTeamNotes(SUPPORT_ACCOUNT_ID, [first.id], NOTE_INDEX_PROPERTIES, { text: true });
    expect(parseNote(list[0])?.text).toContain('billing');

    const created = await client.createTeamNote(SUPPORT_ACCOUNT_ID, {
      mailboxIds: { [SMB.notes]: true }, keywords: { $seen: true },
      from: [{ name: 'Nora Lindqvist', email: 'nora@meridianlabs.example' }], subject: 'Note: Invoice address change',
      'header:X-Bulwark-Note-For:asText': '<x@y>', 'header:X-Bulwark-Note-Kind:asText': 'note',
      bodyStructure: { type: 'text/plain', partId: '1' }, bodyValues: { '1': { value: 'Changed in the CRM.' } },
    });
    expect((await index(client)).map((n) => n.id)).toContain(created.id);
    await client.destroyTeamNote(SUPPORT_ACCOUNT_ID, created.id);
    expect((await index(client)).map((n) => n.id)).not.toContain(created.id);
  });
});
