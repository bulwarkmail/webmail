import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import type { NoteEntry } from '@/lib/team-mailboxes/note-format';

// While Bulwark is open, a mention of the user shows as a toast whose Show
// opens the conversation at the note, and goes into the notification list.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const toasts = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('@/stores/toast-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/toast-store')>()),
  toast: { info: toasts.info, success: vi.fn(), error: vi.fn() },
}));
const recorded = vi.hoisted(() => vi.fn());
vi.mock('@/stores/notification-center-store', () => ({ recordNotification: recorded }));
const opened = vi.hoisted(() => vi.fn());
vi.mock('@/lib/desktop/mail-links', () => ({ openMailLink: opened }));
vi.mock('@/lib/desktop/mention-notifications', () => ({ messageOfNote: async () => 'e7' }));
const watcher = vi.hoisted(() => ({ listeners: new Set<(e: unknown) => void>(), watched: [] as unknown[] }));
vi.mock('@/lib/team-mailboxes/mention-watcher', () => ({
  onMention: (l: (e: unknown) => void) => { watcher.listeners.add(l); return () => watcher.listeners.delete(l); },
  watchMentions: (teams: unknown[]) => { watcher.watched = teams; },
}));

const { TeamMentionHost } = await import('../team-mention-host');

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
const note: NoteEntry = {
  id: 'n9', messageId: 'n9@notes', key: 'k', threadId: 't1', kind: 'note', author: { name: 'Mabel', email: 'mabel@example.org' },
  at: Date.now(), mentions: ['me'], text: 'can you call them?', subject: 'Offer for the Mulberry project',
};

afterEach(() => {
  toasts.info.mockClear();
  recorded.mockClear();
  opened.mockClear();
});

describe('mentions while Bulwark is open', () => {
  it('toasts the mention with Show, which opens the conversation at the note, and lists it', async () => {
    render(<TeamMentionHost />);
    act(() => { for (const l of watcher.listeners) l({ ref, client: {}, note }); });
    expect(toasts.info).toHaveBeenCalledWith('mentioned_you', expect.objectContaining({ action: expect.objectContaining({ label: 'show' }) }));
    expect(recorded).toHaveBeenCalledWith({ level: 'info', title: 'mentioned_you', body: 'can you call them?' });
    const action = (toasts.info.mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1].action;
    await act(async () => { action.onClick(); });
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', id: 'e7', ownerAccountId: 'g', note: 'n9' }), undefined, expect.any(Function));
  });

  it('says only that there was a mention when the note has no subject', () => {
    render(<TeamMentionHost />);
    act(() => { for (const l of watcher.listeners) l({ ref, client: {}, note: { ...note, subject: '' } }); });
    expect(toasts.info).toHaveBeenCalledWith('mentioned_you_hidden', expect.anything());
  });
});
