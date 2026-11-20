import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { NoteEntry } from '@/lib/team-mailboxes/note-format';
import type { TeamRef } from '@/lib/team-mailboxes/team';

// A list row of a team mailbox: the number of notes of its conversation, and
// a dot while one by someone else is newer than the user's last look.

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
let inTeam = true;
vi.mock('../use-team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-team')>()),
  useTeamOf: () => (inTeam ? { ref, client: {} } : null),
}));

const { useTeamMailboxStore, markConversationSeen } = await import('@/stores/team-mailbox-store');
const { TeamRowBadges } = await import('../team-row-badges');

const alice = { name: 'Alice', email: 'tm-alice@example.org' };
const bob = { name: 'Bob', email: 'tm-bob@example.org' };
const note = (id: string, minute: number, author = bob, extra: Partial<NoteEntry> = {}): NoteEntry => ({
  id, messageId: null, key: 'k', threadId: 't1', kind: 'note', author, at: minute * 60_000, mentions: [], text: 'x', ...extra,
});

function seed(notes: NoteEntry[], baselineMinute = 0, seenThreads: Record<string, number> = {}) {
  useTeamMailboxStore.setState({
    teams: {
      [ref.key]: {
        ref, status: 'ready', folderIds: ['notes'], canWrite: true, author: alice, windowStart: 0,
        notes: Object.fromEntries(notes.map((n) => [n.id, n])), pending: {}, conversations: {}, version: 1,
      },
    },
    seen: { login: { g: { baseline: baselineMinute * 60_000, threads: seenThreads } } },
  });
}

const row = { id: 'e1', threadId: 't1', messageId: undefined, sourceClientAccountId: 'login', sourceAccountId: 'g' };
const badge = () => document.querySelector('[data-team-row-notes]') as HTMLElement | null;

afterEach(() => {
  inTeam = true;
  useTeamMailboxStore.setState({ teams: {}, seen: {} });
});

describe('team row badges', () => {
  it('counts the notes of the conversation, not its timeline entries', () => {
    seed([note('a', 10), note('b', 20, alice), note('c', 30, bob, { kind: 'done' })], 100);
    render(<TeamRowBadges email={row} />);
    expect(badge()?.dataset.teamRowNotes).toBe('2');
    expect(badge()?.getAttribute('aria-label')).toBe('summary_count');
  });

  it('shows the dot for a note by someone else after the last look, and drops it once seen', () => {
    seed([note('a', 200), note('mine', 300, alice)], 100);
    render(<TeamRowBadges email={row} />);
    expect(badge()?.hasAttribute('data-team-row-unseen')).toBe(true);
    expect(badge()?.getAttribute('aria-label')).toBe('row_count_new');
    act(() => { markConversationSeen(ref.key, ['t1']); });
    expect(badge()?.hasAttribute('data-team-row-unseen')).toBe(false);
  });

  it('never shows a dot for notes older than the first visit or the user\'s own', () => {
    seed([note('old', 50), note('mine', 300, alice)], 100);
    render(<TeamRowBadges email={row} />);
    expect(badge()?.hasAttribute('data-team-row-unseen')).toBe(false);
  });

  it('shows nothing for a conversation without notes or outside a team mailbox', () => {
    seed([]);
    const { unmount } = render(<TeamRowBadges email={row} />);
    expect(badge()).toBeNull();
    unmount();
    inTeam = false;
    seed([note('a', 200)]);
    render(<TeamRowBadges email={row} />);
    expect(badge()).toBeNull();
  });
});
