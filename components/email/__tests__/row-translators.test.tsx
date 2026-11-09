import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as nextIntl from 'next-intl';
import { ThreadListItem } from '../thread-list-item';
import { RowTranslatorsProvider } from '../row-translators';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import type { Email } from '@/lib/jmap/types';

// The message rows' words come from one set of translators per list, each
// remembering what it said: a search or folder switch draws every row afresh,
// and six translators per row with the same lookups showed in the rig's profile.

vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));

const email = (i: number): Email => ({
  id: `e${i}`, threadId: `t${i}`, mailboxIds: { inbox: true }, keywords: { $seen: true, $answered: true }, size: 1000,
  receivedAt: '2024-01-15T10:00:00Z', from: [{ name: `Sender ${i}`, email: `s${i}@example.com` }], subject: `Subject ${i}`, hasAttachment: false,
});

beforeEach(() => {
  useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
});

describe('row translators', () => {
  it('makes the translators once for a list, not in every row', () => {
    const made = vi.spyOn(nextIntl, 'useTranslations');
    const threads = groupEmailsByThread(Array.from({ length: 20 }, (_, i) => email(i)));
    render(
      <RowTranslatorsProvider>
        {threads.map((thread) => (
          <ThreadListItem key={thread.threadKey} thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />
        ))}
      </RowTranslatorsProvider>,
    );
    const rowWords = ['email_viewer', 'email_list', 'email_list.batch_actions', 'settings.email_behavior.hover_actions', 'threads', 'sidebar'];
    expect(made.mock.calls.filter(([ns]) => rowWords.includes(ns as string)).length).toBe(6);
    made.mockRestore();
  });

  it('asks the catalog once per word for the whole list', () => {
    const translate = vi.fn((key: string) => key);
    const made = vi.spyOn(nextIntl, 'useTranslations').mockImplementation(() => translate as never);
    const threads = groupEmailsByThread(Array.from({ length: 20 }, (_, i) => email(i)));
    render(
      <RowTranslatorsProvider>
        {threads.map((thread) => (
          <ThreadListItem key={thread.threadKey} thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />
        ))}
      </RowTranslatorsProvider>,
    );
    const replied = translate.mock.calls.filter(([key]) => key === 'replied').length;
    expect(replied).toBe(1);
    made.mockRestore();
  });

  it('a row drawn on its own makes its own words', () => {
    const [thread] = groupEmailsByThread([email(1)]);
    const { container } = render(<ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />);
    expect(container.textContent).toContain('Subject 1');
  });
});
