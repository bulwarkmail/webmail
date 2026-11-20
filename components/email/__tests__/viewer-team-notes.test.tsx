import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { TeamRef } from '@/lib/team-mailboxes/team';

// The reader in a team mailbox: a Note button next to Forward, the notes
// after the message, the line above it, and the field at the end. Nothing
// of it outside a team mailbox.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
let inTeam = true;
vi.mock('@/components/team-mailboxes/use-team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/team-mailboxes/use-team')>()),
  useTeamOf: () => (inTeam ? { ref, client: { getAccountId: () => 'me', getUsername: () => 'tm-alice@example.org' } } : null),
}));
vi.mock('@/stores/team-mailbox-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/team-mailbox-store')>()),
  loadConversation: vi.fn(async () => {}),
  repairOriginalKeywords: vi.fn(async () => {}),
  markConversationSeen: vi.fn(),
}));

const { EmailViewer } = await import('../email-viewer');
const { useTeamMailboxStore } = await import('@/stores/team-mailbox-store');

const mailboxes = [{ id: 'g:inbox', originalId: 'inbox', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'g', myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', messageId: ['orig@client.example'], mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Customer', email: 'customer@example.com' }], to: [{ email: 'tm-team@example.org' }],
  subject: 'Offer', receivedAt: '2026-11-20T09:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [], attachments: [], bodyValues: {}, sourceClientAccountId: 'login', sourceAccountId: 'g',
} as unknown as Email;

function seed() {
  useTeamMailboxStore.setState({
    teams: {
      [ref.key]: {
        ref, status: 'ready', folderIds: ['notes'], canWrite: true, author: { name: 'Alice Archer', email: 'tm-alice@example.org' },
        windowStart: 0, pending: {}, conversations: {}, version: 1,
        notes: { n1: { id: 'n1', messageId: 'n1@notes', key: 'orig@client.example', threadId: 't1', kind: 'note', author: { name: 'Bob Baker', email: 'tm-bob@example.org' }, at: Date.parse('2026-11-20T10:00:00Z'), mentions: [], text: 'my job' } },
      },
    },
  });
}

afterEach(() => {
  inTeam = true;
  useTeamMailboxStore.setState({ teams: {} });
});

describe('the reader in a team mailbox', () => {
  it('shows the notes after the message, the line above it and a Note button that opens the field', async () => {
    seed();
    render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="g:inbox" currentMailboxRole="inbox" onDelete={() => {}} />);
    expect(document.querySelector('[data-team-notes-after="e1"]')?.textContent).toContain('my job');
    expect(document.querySelector('[data-team-notes-summary]')).toBeTruthy();
    const toolbarNote = document.querySelector('[data-team-note-toolbar]') as HTMLElement;
    expect(toolbarNote).toBeTruthy();
    await act(async () => { fireEvent.click(toolbarNote); });
    expect(screen.getByLabelText('field_label')).toBeTruthy();
  });

  it('shows none of it outside a team mailbox', () => {
    inTeam = false;
    seed();
    render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="g:inbox" currentMailboxRole="inbox" onDelete={() => {}} />);
    expect(document.querySelector('[data-team-notes-after]')).toBeNull();
    expect(document.querySelector('[data-team-note-toolbar]')).toBeNull();
    expect(document.querySelector('[data-team-note-area]')).toBeNull();
  });
});
