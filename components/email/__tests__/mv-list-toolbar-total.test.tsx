import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The unified inbox has no single folder to take a count from, so its range
// readout said "1–100 of 100": the total was just the rows loaded so far
// (#1471). It now uses the total the accounts' queries reported.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useLocale: () => 'en',
}));

const { MvListToolbar } = await import('../mv-list-toolbar');
const { useEmailStore } = await import('@/stores/email-store');
const { useAuthStore } = await import('@/stores/auth-store');

const message = (id: string): Email =>
  ({ id, threadId: id, keywords: {}, mailboxIds: { inbox: true } }) as unknown as Email;

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 40, unreadEmails: 0 } as Mailbox;

const range = () => screen.getByText(/^conversations_range /).textContent ?? '';

describe('MvListToolbar range total (#1471)', () => {
  beforeEach(() => {
    useAuthStore.setState({ client: {} as never } as never);
    useEmailStore.setState({
      emails: [message('a'), message('b')],
      mailboxes: [inbox],
      selectedEmailKeys: new Set(),
      totalEmails: 3412,
    } as never);
  });

  it('shows the accounts\' query total in a unified view', () => {
    useEmailStore.setState({ isUnifiedView: true, unifiedRole: 'inbox', selectedMailbox: 'unified-inbox' } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    expect(range()).toContain('"total":3412');
  });

  it('keeps the folder count in a single folder', () => {
    useEmailStore.setState({ isUnifiedView: false, unifiedRole: null, selectedMailbox: 'inbox' } as never);
    render(<MvListToolbar loadedCount={2} totalCount={40} onRefresh={() => {}} />);
    expect(range()).toContain('"total":40');
  });

  it('never shows fewer than the rows already loaded', () => {
    useEmailStore.setState({ isUnifiedView: true, unifiedRole: 'inbox', selectedMailbox: 'unified-inbox', totalEmails: 0 } as never);
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
    expect(range()).toContain('"total":2');
  });
});
