import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNoteEmail } from '../note-format';
import { emitPushStateChange } from '@/lib/push-events';
import type { TeamRef } from '../team';
import { onMention, resetMentionWatcher, settleMentionWatcher, watchMentions } from '../mention-watcher';
import { FakeTeamServer, GROUP } from '@/stores/__tests__/helpers/fake-team-server';

// A mention reaches the person mentioned from sign-in on, wherever they are
// in the app; nobody else hears anything.

const ref: TeamRef = { key: `login|${GROUP}`, loginId: 'login', accountId: GROUP, groupAddress: 'tm-team@example.org' };
const bob = { name: 'Bob Baker', email: 'tm-bob@example.org' };

function noteBy(server: FakeTeamServer, author: { name: string; email: string }, mentions: string[], kind: 'note' | 'assigned' = 'note') {
  const { email } = buildNoteEmail({ mailboxId: 'notes', author, groupAddress: ref.groupAddress, subject: 'Offer', key: 'k', threadId: 't1', kind, mentions, text: 'look at this' });
  return server.addNote(email);
}

async function push(server: FakeTeamServer, client: ReturnType<FakeTeamServer['client']>) {
  emitPushStateChange({ '@type': 'StateChange', changed: { [GROUP]: { Email: server.state } } }, client, 'active');
  await settleMentionWatcher();
}

afterEach(() => resetMentionWatcher());

describe('the mention watcher', () => {
  it('tells the mentioned member once, and only about notes written after it started', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    noteBy(server, bob, ['me']);
    const client = server.client();
    const heard = vi.fn();
    onMention(heard);
    watchMentions([{ ref, client }]);
    await settleMentionWatcher();

    const id = noteBy(server, bob, ['me', 'hw']);
    await push(server, client);
    await push(server, client);

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toMatchObject({ ref, note: { id, kind: 'note', author: bob, subject: 'Offer' } });
  });

  it('stays quiet for notes that mention someone else, timeline entries naming the user, and the user\'s own notes', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const client = server.client();
    const heard = vi.fn();
    onMention(heard);
    watchMentions([{ ref, client }]);
    await settleMentionWatcher();

    noteBy(server, bob, ['hw']);
    noteBy(server, bob, ['me'], 'assigned');
    noteBy(server, { name: 'Alice Archer', email: 'tm-alice@example.org' }, ['me']);
    server.touchMail('mail-7');
    await push(server, client);

    expect(heard).not.toHaveBeenCalled();
  });

  it('stops watching a team that is no longer on', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const client = server.client();
    const heard = vi.fn();
    onMention(heard);
    watchMentions([{ ref, client }]);
    await settleMentionWatcher();
    watchMentions([]);
    noteBy(server, bob, ['me']);
    await push(server, client);
    expect(heard).not.toHaveBeenCalled();
  });
});
