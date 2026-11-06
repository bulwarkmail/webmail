import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { NoLongerScheduledError, SubmissionQuotaError } from '@/lib/jmap/client';
import { toast } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { flushComposers, resetComposeFlushRegistry } from '@/lib/compose-flush-registry';

// Sending from the viewer - quick reply, "Send now" / "Reschedule" of a
// scheduled message, and read receipts - used to fail silently or as an
// unhandled rejection. At a full Stalwart 1.0 submission quota every one of
// them fails, so each has to say so; the automatic read receipt must not
// retry on every refresh either.

// The rules menu resolves the account and Sieve support from the client, which this test stubs only for sending.
vi.mock('@/components/email/rules-menu', () => ({
  RulesPanel: () => null,
  useRulesAvailability: () => ({ availability: 'hidden', target: null }),
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: () => [],
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const QUOTA = 'There are too many email submissions, please delete some before adding a new one.';

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function makeEmail(overrides: Record<string, unknown> = {}): Email {
  return {
    id: 'e1',
    blobId: 'b1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }],
    to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello',
    receivedAt: '2026-01-01T00:00:00Z',
    preview: 'Hello',
    hasAttachment: false,
    size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [],
    attachments: [],
    bodyValues: { '1': { value: 'Hello Bob', isTruncated: false } },
    ...overrides,
  } as unknown as Email;
}

let toastError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useSettingsStore.setState({ quickReplyEnabled: true });
  toastError = vi.spyOn(toast, 'error').mockImplementation(() => '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('viewer send failures', () => {
  it('hides quick reply when disabled and restores it when enabled', () => {
    useSettingsStore.setState({ quickReplyEnabled: false });
    render(<EmailViewer email={makeEmail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

    expect(screen.queryByPlaceholderText('quick_reply_to')).not.toBeInTheDocument();
    act(() => useSettingsStore.getState().updateSetting('quickReplyEnabled', true));
    expect(screen.getByPlaceholderText('quick_reply_to')).toBeInTheDocument();
  });

  it('reports a failed quick reply and keeps the text on Stalwart 1.0', async () => {
    const onQuickReply = vi.fn().mockRejectedValue(new SubmissionQuotaError(QUOTA, true));
    render(
      <EmailViewer email={makeEmail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={onQuickReply} />,
    );

    const box = screen.getByPlaceholderText('quick_reply_to');
    fireEvent.change(box, { target: { value: 'Thanks!' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('submission_quota'));
    expect(onQuickReply).toHaveBeenCalledWith('Thanks!', { composerId: expect.any(String) });
    expect((box as HTMLTextAreaElement).value).toBe('Thanks!');
  });

  it('keeps typed quick-reply text as a draft before an automatic sign-out', async () => {
    resetComposeFlushRegistry();
    const onSaveQuickReplyDraft = vi.fn().mockResolvedValue(undefined);
    render(
      <EmailViewer email={makeEmail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        onQuickReply={vi.fn()} onSaveQuickReplyDraft={onSaveQuickReplyDraft} />,
    );
    await act(async () => { await flushComposers(1000); });
    expect(onSaveQuickReplyDraft).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('quick_reply_to'), { target: { value: 'On it.' } });
    await act(async () => { await flushComposers(1000); });
    expect(onSaveQuickReplyDraft).toHaveBeenCalledWith('On it.');
  });

  // The PWA install and push cards hide while this is set (#1411).
  it('marks an expanded quick reply as composing, so floating cards keep off Send', () => {
    useUIStore.setState({ composingCount: 0 });
    render(<EmailViewer email={makeEmail()} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn()} />);
    expect(useUIStore.getState().composingCount).toBe(0);

    fireEvent.focus(screen.getByPlaceholderText('quick_reply_to'));
    expect(useUIStore.getState().composingCount).toBe(1);

    fireEvent.click(screen.getByText('cancel'));
    expect(useUIStore.getState().composingCount).toBe(0);
  });

  const scheduled = () => makeEmail({
    isScheduled: true,
    scheduledUndoStatus: 'pending',
    scheduledSendAt: new Date(Date.now() + 3_600_000).toISOString(),
    emailSubmissionId: 'sub-1',
    scheduledIdentityId: 'identity-1',
    keywords: { $seen: true },
  });

  it('waits for "Send now" and says the message is still scheduled at a full quota on Stalwart 1.0', async () => {
    const onRescheduleScheduled = vi.fn().mockRejectedValue(new SubmissionQuotaError(QUOTA, true));
    render(
      <EmailViewer
        email={scheduled()}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        onRescheduleScheduled={onRescheduleScheduled}
      />,
    );

    fireEvent.click(screen.getAllByText('send_now').at(-1)!);

    // The i18n test mock renders keys: "still scheduled for {date}", then why.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('still_scheduled_at', { message: 'submission_quota' }));
    expect(onRescheduleScheduled).toHaveBeenCalledTimes(1);
  });

  it('offers Cancel send, and shows one set of scheduled actions and no draft bar', () => {
    const onCancelScheduledSend = vi.fn();
    render(
      <EmailViewer
        email={makeEmail({ ...scheduled(), keywords: { $seen: true, $draft: true } })}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        onCancelScheduledSend={onCancelScheduledSend}
        onCancelScheduledForEdit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('cancel-scheduled-send'));
    expect(onCancelScheduledSend).toHaveBeenCalledTimes(1);
    // The banner's buttons are for the phone only, where the toolbar has none.
    const bannerReschedule = screen.getAllByText('reschedule_send').map(el => el.closest('div.flex-wrap')).find(Boolean);
    expect(bannerReschedule?.className).toContain('sm:hidden');
    expect(screen.getAllByText('send_now')).toHaveLength(1);
    expect(screen.queryByText('draft_banner')).toBeNull();
  });

  it('reschedules through the schedule dialog, not a browser prompt', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    const onRescheduleScheduled = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ client: { hasDelayedSend: () => true, getMaxDelayedSend: () => 0 } as never });
    render(
      <EmailViewer
        email={scheduled()}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        onRescheduleScheduled={onRescheduleScheduled}
      />,
    );

    fireEvent.click(screen.getAllByText('reschedule_send').at(-1)!);
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText('schedule_preset.tomorrow_afternoon'));

    await waitFor(() => expect(onRescheduleScheduled).toHaveBeenCalledTimes(1));
    expect(new Date(onRescheduleScheduled.mock.calls[0][0]).getHours()).toBe(13);
  });

  it('says the message was already sent when it went out while room was made on Stalwart 1.0', async () => {
    const onRescheduleScheduled = vi.fn().mockRejectedValue(new NoLongerScheduledError(true));
    render(
      <EmailViewer
        email={scheduled()}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        onRescheduleScheduled={onRescheduleScheduled}
      />,
    );

    fireEvent.click(screen.getAllByText('send_now').at(-1)!);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('already_sent', undefined));
  });

  it('explains a full submission quota when the unsubscribe mail cannot go out on Stalwart 1.0', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new SubmissionQuotaError(QUOTA, true));
    useAuthStore.setState({ client: { sendEmail } as never });
    try {
      render(
        <EmailViewer
          email={makeEmail({ headers: { 'List-Unsubscribe': '<mailto:leave@lists.example.com?subject=unsubscribe>' } })}
          mailboxes={mailboxes}
          selectedMailbox="inbox"
          currentMailboxRole="inbox"
        />,
      );

      fireEvent.click(screen.getAllByText('email_viewer.unsubscribe_banner.button').at(-1)!);
      fireEvent.click(screen.getAllByText('email_viewer.unsubscribe_banner.confirm_button').at(-1)!);

      await waitFor(() => expect(toastError).toHaveBeenCalledWith('submission_quota'));
      expect(sendEmail).toHaveBeenCalledWith(['leave@lists.example.com'], 'unsubscribe', '', undefined, undefined, undefined, undefined, undefined, undefined);
      expect(screen.getAllByText('email_viewer.unsubscribe_banner.error').length).toBeGreaterThan(0);
    } finally {
      useAuthStore.setState({ client: null } as never);
    }
  });

  describe('automatic read receipts', () => {
    const MDN_HEADERS = { 'Disposition-Notification-To': 'Alice <alice@example.com>' };
    let sendReadReceipt: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      sendReadReceipt = vi.fn().mockRejectedValue(new SubmissionQuotaError(QUOTA, true));
      useSettingsStore.setState({ readReceiptResponse: 'always' });
      useAuthStore.setState({
        client: { sendReadReceipt } as never,
        identities: [{ id: 'identity-1', email: 'bob@example.com', name: 'Bob', mayDelete: false }] as never,
      });
    });

    afterEach(() => {
      useSettingsStore.setState({ readReceiptResponse: 'ask' });
      useAuthStore.setState({ client: null, identities: [] } as never);
    });

    it('a message opened from a link sends none by itself', async () => {
      render(<EmailViewer email={makeEmail({ headers: MDN_HEADERS })} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" noAutomaticActions />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(sendReadReceipt).not.toHaveBeenCalled();
    });

    it('tries once per opening, not once per refresh, when the quota is full on Stalwart 1.0', async () => {
      const props = { mailboxes, selectedMailbox: 'inbox', currentMailboxRole: 'inbox' };
      const { rerender } = render(<EmailViewer email={makeEmail({ headers: MDN_HEADERS })} {...props} />);

      await waitFor(() => expect(sendReadReceipt).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('read_receipt.send_failed', { message: 'submission_quota' }));

      // Refreshes hand the viewer new objects for the same message.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          rerender(<EmailViewer email={makeEmail({ headers: MDN_HEADERS, preview: `refresh ${i}` })} {...props} />);
        });
      }
      expect(sendReadReceipt).toHaveBeenCalledTimes(1);

      // Opening another message and coming back tries again.
      await act(async () => {
        rerender(<EmailViewer email={makeEmail({ id: 'e2' })} {...props} />);
      });
      await act(async () => {
        rerender(<EmailViewer email={makeEmail({ headers: MDN_HEADERS })} {...props} />);
      });
      await waitFor(() => expect(sendReadReceipt).toHaveBeenCalledTimes(2));
    });

    // A group's message with an id the own account uses too: $MDNSent goes
    // to the login and account the message was read in.
    it('flags the message in the login and account it was read in', async () => {
      sendReadReceipt.mockResolvedValue(undefined);
      const markEmailKeyword = vi.fn().mockResolvedValue(undefined);
      useEmailStore.setState({ markEmailKeyword } as never);
      const client = useAuthStore.getState().client;
      const blobSource = { client, clientAccountId: 'login-a', accountId: 'ce' };

      render(<EmailViewer email={makeEmail({ headers: MDN_HEADERS })} blobSource={blobSource as never} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

      await waitFor(() => expect(markEmailKeyword).toHaveBeenCalled());
      expect(markEmailKeyword).toHaveBeenCalledWith(client, 'e1', '$mdnsent', expect.objectContaining({ clientAccountId: 'login-a', accountId: 'ce' }));
    });
  });
});

describe('recipients in the header', () => {
  it('puts the comma after a name and makes Cc "+N" open the full list', () => {
    const { container } = render(
      <EmailViewer
        email={makeEmail({
          to: [{ name: 'Alice Johnson', email: 'alice@example.com' }, { name: 'Bob Chen', email: 'bob@example.com' }],
          cc: [{ email: 'c1@example.com' }, { email: 'c2@example.com' }, { email: 'c3@example.com' }],
        })}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
      />,
    );
    const alice = screen.getAllByText('Alice Johnson')[0].closest('span.inline-flex')!;
    expect(alice.textContent).toBe('Alice Johnson,');
    expect(container.textContent).not.toContain('+1');
    expect(screen.getAllByRole('button', { name: 'more_count' }).length).toBeGreaterThan(0);
  });
});
