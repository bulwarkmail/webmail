import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * A Pro folder tab marked a message read the moment its row was clicked,
 * ignoring "Mark as read: Never" / a delay. It must follow markAsReadDelay
 * like the reading pane does.
 */

vi.mock('@/components/pro/pro-email-tab-body', () => ({
  ProEmailView: ({ emailId }: { emailId: string }) => React.createElement('div', { 'data-testid': 'reader' }, emailId),
}));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: () => null,
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
}));

const client = vi.hoisted(() => ({
  getEmails: vi.fn(),
  markAsRead: vi.fn(async () => {}),
}));

vi.mock('@/stores/auth-store', () => {
  const state = { client, getClientForAccount: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useAuthStore: hook };
});

const { ProFolderTabBody } = await import('../pro-folder-tab-body');

const unread = (id: string, subject: string): Email =>
  ({
    id,
    threadId: id,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ name: 'Sender', email: 'sender@example.com' }],
    subject,
    receivedAt: '2026-10-01T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
  }) as unknown as Email;

async function renderTab() {
  render(
    <ProFolderTabBody
      tabId="folder-1"
      data={{ accountId: null, mailboxId: 'inbox', title: 'Inbox' }}
    />,
  );
  await act(async () => {});
}

describe('Pro folder tab row click follows markAsReadDelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.markAsRead.mockClear();
    client.getEmails.mockResolvedValue({
      emails: [unread('e1', 'First'), unread('e2', 'Second')],
      total: 2,
      hasMore: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not mark the message read with "Never" (-1)', async () => {
    useSettingsStore.setState({ markAsReadDelay: -1 });
    await renderTab();

    fireEvent.click(screen.getByText('First'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(screen.getByTestId('reader')).toHaveTextContent('e1');
    expect(client.markAsRead).not.toHaveBeenCalled();
  });

  it('marks the message read at once with "Instantly" (0)', async () => {
    useSettingsStore.setState({ markAsReadDelay: 0 });
    await renderTab();

    fireEvent.click(screen.getByText('First'));
    await act(async () => {});

    expect(client.markAsRead).toHaveBeenCalledWith('e1', true, undefined);
  });

  it('marks the message read after the delay, and only the row still open', async () => {
    useSettingsStore.setState({ markAsReadDelay: 3000 });
    await renderTab();

    fireEvent.click(screen.getByText('First'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    // Moving on to another row before the delay ran out drops the first mark.
    fireEvent.click(screen.getByText('Second'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(client.markAsRead).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
    expect(client.markAsRead).toHaveBeenCalledWith('e2', true, undefined);
  });
});
