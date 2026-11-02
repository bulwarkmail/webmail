import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox, ThreadGroup } from '@/lib/jmap/types';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { clearOffers, offerSlots, slotProps } from '@/components/plugins/__tests__/fake-plugin-offer';
import { requestPanel } from '@/lib/plugin-sandbox/panel-requests';

// Plugin surfaces of the open message: frames above the subject, under the
// sender, between new text and quote, above a conversation; buttons in the
// reader toolbar (More panel on phones); entries in an attachment's menu.

const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
  useMediaQuery: () => false,
  useIsMobile: () => device.isMobile,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-iframe-slot', async () => ({
  PluginIframeSlot: (await import('@/components/plugins/__tests__/fake-plugin-offer')).FakeIframeSlot,
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { ThreadConversationView } = await import('../thread-conversation-view');
const { ReaderAboveQuoteSlot, QUOTE_ANCHOR_ATTR } = await import('../reader-plugin-surfaces');
const { useSettingsStore } = await import('@/stores/settings-store');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function mail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello there', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
    textBody: [], htmlBody: [], attachments: [], bodyValues: {},
    ...overrides,
  } as unknown as Email;
}

function textMail(text: string, overrides: Partial<Email> = {}): Email {
  return mail({
    textBody: [{ partId: '1', type: 'text/plain' }],
    bodyValues: { '1': { value: text, isTruncated: false } },
    ...overrides,
  } as Partial<Email>);
}

const REPLY = 'Sounds good, see you then.\n\nOn Monday Bob wrote:\n> Shall we meet at ten?\n> Bob';

function viewer(email: Email, props: Partial<React.ComponentProps<typeof EmailViewer>> = {}) {
  return render(
    <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" {...props} />,
  );
}

const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

const dispatch = vi.fn().mockResolvedValue(undefined);
const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  device.isMobile = false;
  resetActions();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
  useSettingsStore.setState(initialSettings, true);
});

afterEach(() => {
  clearOffers();
  setActionDispatcher(null);
});

describe('email-detail-sidebar', () => {
  // Reports a fixed width for whatever it observes, like a 584 px reading pane
  // (three panes on a laptop).
  function stubWidth(width: number) {
    class FixedWidthObserver {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FixedWidthObserver);
  }

  afterEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    try { localStorage.removeItem('emailDetailSidebarCollapsed'); } catch { /* ignore */ }
  });

  it('starts collapsed when the message opens into a pane too narrow for it', () => {
    stubWidth(584);
    offerSlots('p1', ['email-detail-sidebar']);
    // The reader mounts empty first, then a message opens.
    const { rerender } = render(
      <EmailViewer email={null} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />,
    );
    rerender(<EmailViewer email={textMail('Hi')} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

    expect(screen.queryByTestId('slot-email-detail-sidebar')).toBeNull();
    expect(screen.getByRole('button', { name: 'plugin_panel_show' })).toBeInTheDocument();
  });

  it('lays the panel over the message when opened anyway, instead of squeezing it', () => {
    stubWidth(584);
    offerSlots('p1', ['email-detail-sidebar']);
    viewer(textMail('Hi'));

    fireEvent.click(screen.getByRole('button', { name: 'plugin_panel_show' }));
    const panel = screen.getByTestId('slot-email-detail-sidebar').closest('[data-plugin-detail-panel]')!;
    expect(panel.getAttribute('data-plugin-detail-panel')).toBe('overlay');
    expect(panel.className).toContain('absolute');
  });

  it('opens, closes and toggles on a plugin\'s request, and tells the slot to focus', () => {
    stubWidth(584);
    offerSlots('p1', ['email-detail-sidebar']);
    viewer(textMail('Hi'));
    expect(screen.queryByTestId('slot-email-detail-sidebar')).toBeNull();

    let open: boolean | null = false;
    act(() => { open = requestPanel('p1', 'email-detail-sidebar', 'open', undefined); });
    expect(open).toBe(true);
    const panel = screen.getByTestId('slot-email-detail-sidebar').closest('[data-plugin-detail-panel]')!;
    expect(panel.getAttribute('data-plugin-detail-panel')).toBe('overlay');
    expect(slotProps(screen.getByTestId('slot-email-detail-sidebar')).focusRequest).toBe(1);

    act(() => { open = requestPanel('p1', 'email-detail-sidebar', 'toggle', undefined); });
    expect(open).toBe(false);
    expect(screen.queryByTestId('slot-email-detail-sidebar')).toBeNull();

    act(() => { open = requestPanel('p1', 'email-detail-sidebar', 'toggle', undefined); });
    expect(open).toBe(true);
    expect(slotProps(screen.getByTestId('slot-email-detail-sidebar')).focusRequest).toBe(2);

    act(() => { open = requestPanel('p1', 'email-detail-sidebar', 'close', undefined); });
    expect(open).toBe(false);
    expect(screen.queryByTestId('slot-email-detail-sidebar')).toBeNull();
  });

  it('answers no request on phones, where there is no panel', () => {
    device.isMobile = true;
    offerSlots('p1', ['email-detail-sidebar']);
    viewer(textMail('Hi'));
    let open: boolean | null = true;
    act(() => { open = requestPanel('p1', 'email-detail-sidebar', 'open', undefined); });
    expect(open).toBeNull();
    expect(screen.queryByTestId('slot-email-detail-sidebar')).toBeNull();
  });

  it('starts folded when the plugin asks for it, and remembers the user opening it', () => {
    stubWidth(1000);
    offerSlots('p1', ['email-detail-sidebar'], { startFolded: ['email-detail-sidebar'] });
    const { unmount } = viewer(textMail('Hi'));
    expect(screen.queryByTestId('slot-email-detail-sidebar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'plugin_panel_show' }));
    expect(screen.getByTestId('slot-email-detail-sidebar').closest('[data-plugin-detail-panel]')!.getAttribute('data-plugin-detail-panel')).toBe('docked');
    unmount();
    viewer(textMail('Hi'));
    expect(screen.getByTestId('slot-email-detail-sidebar')).toBeInTheDocument();
  });

  it('docks next to the message when there is room', () => {
    stubWidth(1000);
    offerSlots('p1', ['email-detail-sidebar']);
    viewer(textMail('Hi'));

    const panel = screen.getByTestId('slot-email-detail-sidebar').closest('[data-plugin-detail-panel]')!;
    expect(panel.getAttribute('data-plugin-detail-panel')).toBe('docked');
  });
});

describe('reader-selection-menu and the side panel\'s selection', () => {
  const SURFACE = 'reader-selection-menu';
  const plainBody = () => document.querySelector<HTMLElement>('[data-plugin-source="email-body"]')!;
  const selectBody = () => {
    const range = document.createRange();
    range.selectNodeContents(plainBody());
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const rightClick = () => {
    const event = createEvent.contextMenu(plainBody(), { clientX: 30, clientY: 40 });
    fireEvent(plainBody(), event);
    return event;
  };

  afterEach(() => {
    vi.useRealTimers();
    window.getSelection()?.removeAllRanges();
  });

  it('leaves the browser menu alone without plugin entries, and without a selection', () => {
    viewer(textMail('Hi there'));
    selectBody();
    expect(rightClick().defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => { setPluginActions('p1', 'P1', SURFACE, [{ id: 'explain', label: 'Explain' }]); });
    window.getSelection()!.removeAllRanges();
    expect(rightClick().defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers Copy and the plugin entries on selected text, and hands the click the message and the text', async () => {
    act(() => { setPluginActions('p1', 'P1', SURFACE, [{ id: 'explain', label: 'Explain', icon: 'sparkles' }]); });
    viewer(textMail('Hi there'));
    selectBody();

    expect(rightClick().defaultPrevented).toBe(true);
    expect(screen.getByRole('menu')).toHaveTextContent('copy');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Explain' }));
    await act(async () => {});
    expect(dispatch).toHaveBeenCalledWith('p1', SURFACE, 'explain', { emailId: 'e1', selection: { text: 'Hi there' } });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('sends the side panel the selected text a moment after it changes', () => {
    offerSlots('p1', ['email-detail-sidebar']);
    viewer(textMail('Hi there'));
    expect(slotProps(screen.getByTestId('slot-email-detail-sidebar')).selection).toEqual({ text: '' });

    vi.useFakeTimers();
    selectBody();
    act(() => { document.dispatchEvent(new Event('selectionchange')); });
    expect(slotProps(screen.getByTestId('slot-email-detail-sidebar')).selection).toEqual({ text: '' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(slotProps(screen.getByTestId('slot-email-detail-sidebar')).selection).toEqual({ text: 'Hi there' });
  });
});

describe('reader-header and reader-below-subject', () => {
  it('tell the frames which layout they are in', () => {
    offerSlots('p1', ['email-banner']);
    const { unmount } = viewer(textMail('Hi'));
    expect(slotProps(screen.getByTestId('slot-email-banner')).deviceType).toBe('desktop');
    unmount();
    device.isMobile = true;
    viewer(textMail('Hi'));
    expect(slotProps(screen.getByTestId('slot-email-banner')).deviceType).toBe('mobile');
  });

  it('put the frames above the subject and under the sender, with the message', () => {
    offerSlots('p1', ['reader-header', 'reader-below-subject']);
    const { container } = viewer(textMail('Hi'));

    const header = screen.getByTestId('slot-reader-header');
    const below = screen.getByTestId('slot-reader-below-subject');
    const subject = screen.getByRole('heading', { name: 'Hello there' });
    const body = container.querySelector('.email-content-wrapper')!;
    expect(follows(header, subject)).toBe(true);
    expect(follows(subject, below)).toBe(true);
    expect(follows(below, body)).toBe(true);
    expect((slotProps(header).email as { id: string }).id).toBe('e1');
    expect((slotProps(below).email as { subject: string }).subject).toBe('Hello there');
  });

  it('draw nothing without a plugin', () => {
    const { container } = viewer(textMail('Hi'));
    expect(container.querySelector('[data-plugin-slot="reader-header"]')).toBeNull();
    expect(container.querySelector('[data-plugin-slot="reader-below-subject"]')).toBeNull();
  });
});

describe('email-footer', () => {
  it('hands the frame the id of the open message', () => {
    offerSlots('p1', ['email-footer']);
    viewer(textMail('Hi'));
    expect(slotProps(screen.getByTestId('slot-email-footer'))).toEqual({ emailId: 'e1' });
  });
});

describe('reader-above-quote', () => {
  it('sits between the new text of a plain-text reply and its folded quote', () => {
    offerSlots('p1', ['reader-above-quote']);
    const { container } = viewer(textMail(REPLY));

    const frame = screen.getByTestId('slot-reader-above-quote');
    const quote = container.querySelector('.email-content-text details')!;
    expect(quote).not.toBeNull();
    expect(follows(frame, quote)).toBe(true);
    expect(follows(screen.getByText(/Sounds good/), frame)).toBe(true);
    expect((slotProps(frame).email as { id: string }).id).toBe('e1');
    // The frame renders inside the anchor, so the anchor must grow with it
    // instead of letting the frame spill over the quote toggle and the footer.
    const anchor = container.querySelector<HTMLElement>(`[${QUOTE_ANCHOR_ATTR}]`)!;
    expect(anchor.contains(frame)).toBe(true);
    expect(anchor.style.height).toBe('');
  });

  it('is not mounted for a message without a quote, or without a plugin', () => {
    offerSlots('p1', ['reader-above-quote']);
    const { unmount } = viewer(textMail('Just some text.'));
    expect(screen.queryByTestId('slot-reader-above-quote')).toBeNull();
    unmount();
    clearOffers();
    const { container } = viewer(textMail(REPLY));
    expect(container.querySelector(`[${QUOTE_ANCHOR_ATTR}]`)).toBeNull();
  });

  it('lays the frame over an HTML body and makes room for it before the quote toggle', () => {
    offerSlots('p1', ['reader-above-quote']);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const iframe = document.createElement('iframe');
    host.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>New text</p><button data-quote-toggle>...</button><blockquote type="cite">Old</blockquote>';

    const { unmount } = render(
      <ReaderAboveQuoteSlot root={doc.body} frame={iframe} extraProps={{ email: { id: 'e1' } }} />,
      { container: host.appendChild(document.createElement('div')) },
    );

    const anchor = doc.querySelector(`[${QUOTE_ANCHOR_ATTR}]`)!;
    expect(anchor.nextElementSibling).toBe(doc.querySelector('[data-quote-toggle]'));
    const overlay = document.querySelector('[data-plugin-quote-overlay]')!;
    expect(within(overlay as HTMLElement).getByTestId('slot-reader-above-quote')).toBeInTheDocument();
    unmount();
    expect(doc.querySelector(`[${QUOTE_ANCHOR_ATTR}]`)).toBeNull();
    host.remove();
  });

  it('shows in a conversation message on phones too', () => {
    offerSlots('p1', ['reader-above-quote']);
    const email = textMail(REPLY, { keywords: {} } as Partial<Email>);
    const thread = { threadKey: 't1', latestEmail: email, emails: [email], emailCount: 1 } as unknown as ThreadGroup;
    render(<ThreadConversationView thread={thread} emails={[email]} onBack={() => {}} />);

    expect(screen.getByTestId('slot-reader-above-quote')).toBeInTheDocument();
  });
});

describe('thread-summary', () => {
  const conversation = [
    textMail('First', { id: 'm1', receivedAt: '2026-01-01T00:00:00Z' } as Partial<Email>),
    textMail('Second', { id: 'm2', receivedAt: '2026-01-02T00:00:00Z' } as Partial<Email>),
  ];

  it('sits above the messages of the phone conversation view', () => {
    device.isMobile = true;
    offerSlots('p1', ['thread-summary']);
    const thread = { threadKey: 't1', latestEmail: conversation[1], emails: conversation, emailCount: 2 } as unknown as ThreadGroup;
    render(<ThreadConversationView thread={thread} emails={[conversation[1], conversation[0]]} onBack={() => {}} />);

    const frame = screen.getByTestId('slot-thread-summary');
    expect(slotProps(frame)).toEqual({ threadId: 't1', emailIds: ['m2', 'm1'], deviceType: 'mobile' });
    expect(follows(frame, screen.getAllByText('Alice')[0])).toBe(true);
  });

  it('sits above a Mountain View conversation', () => {
    offerSlots('p1', ['thread-summary']);
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', markAsReadDelay: 0 });
    viewer(conversation[1], { mvConversation: conversation });

    expect(slotProps(screen.getByTestId('slot-thread-summary'))).toEqual({ threadId: 't1', emailIds: ['m1', 'm2'], deviceType: 'desktop' });
  });

  it('draws nothing without a plugin, and nothing for a single message', () => {
    const thread = { threadKey: 't1', latestEmail: conversation[1], emails: conversation, emailCount: 2 } as unknown as ThreadGroup;
    const { unmount } = render(<ThreadConversationView thread={thread} emails={conversation} onBack={() => {}} />);
    expect(screen.queryByTestId('slot-thread-summary')).toBeNull();
    unmount();
    offerSlots('p1', ['thread-summary']);
    viewer(conversation[1]);
    expect(screen.queryByTestId('slot-thread-summary')).toBeNull();
  });
});

describe('reader surfaces in the phone conversation view', () => {
  const conversation = [
    textMail('Second', { id: 'm2', subject: 'Re: Plan', receivedAt: '2026-01-02T00:00:00Z' } as Partial<Email>),
    textMail('First', { id: 'm1', subject: 'Plan', receivedAt: '2026-01-01T00:00:00Z' } as Partial<Email>),
  ];
  const thread = { threadKey: 't1', latestEmail: conversation[0], emails: conversation, emailCount: 2 } as unknown as ThreadGroup;

  it('mounts the single reader\'s frames on the unfolded message only', () => {
    offerSlots('p1', ['reader-header', 'reader-below-subject', 'email-banner', 'email-footer']);
    render(<ThreadConversationView thread={thread} emails={conversation} onBack={() => {}} />);

    // The latest message is unfolded, the older one (read) is folded.
    for (const slot of ['reader-header', 'reader-below-subject', 'email-banner'] as const) {
      const frames = screen.getAllByTestId(`slot-${slot}`);
      expect(frames).toHaveLength(1);
      expect((slotProps(frames[0]).email as { id: string }).id).toBe('m2');
    }
    const footer = screen.getAllByTestId('slot-email-footer');
    expect(footer).toHaveLength(1);
    expect(slotProps(footer[0])).toEqual({ emailId: 'm2' });
    // Header on top, the body between banner and footer.
    expect(follows(screen.getByTestId('slot-reader-header'), screen.getByTestId('slot-reader-below-subject'))).toBe(true);
    expect(follows(screen.getByTestId('slot-email-banner'), screen.getByText('Second'))).toBe(true);
    expect(follows(screen.getByText('Second'), footer[0])).toBe(true);
  });

  it('puts plugin reader actions behind a more button on the unfolded message', async () => {
    act(() => setPluginActions('p', 'Translator', 'reader-actions', [{ id: 'translate', label: 'Translate', mailboxRoles: ['inbox'] }]));
    const { unmount } = render(<ThreadConversationView thread={thread} emails={conversation} onBack={() => {}} mailboxRole="inbox" />);

    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const item = await screen.findByRole('menuitem', { name: 'Translate' });
    await act(async () => { fireEvent.click(item); });
    expect(dispatch).toHaveBeenCalledWith('p', 'reader-actions', 'translate', { emailId: 'm2' });
    unmount();

    // Kept to the folder roles the plugin asked for.
    render(<ThreadConversationView thread={thread} emails={conversation} onBack={() => {}} mailboxRole="junk" />);
    expect(screen.queryByRole('button', { name: 'more_actions' })).toBeNull();
  });
});

describe('reader-actions', () => {
  it('adds the plugin buttons to the reader toolbar', async () => {
    act(() => setPluginActions('p', 'Translator', 'reader-actions', [{ id: 'translate', label: 'Translate' }]));
    viewer(textMail('Hola'));

    const button = screen.getByRole('button', { name: 'Translate' });
    expect(button.closest('[data-plugin-actions="reader-actions"]')).not.toBeNull();
    await act(async () => { fireEvent.click(button); });
    expect(dispatch).toHaveBeenCalledWith('p', 'reader-actions', 'translate', { emailId: 'e1' });
  });

  it('keeps to the folder roles the plugin asked for', () => {
    act(() => setPluginActions('p', 'P', 'reader-actions', [{ id: 'translate', label: 'Translate', mailboxRoles: ['junk'] }]));
    viewer(textMail('Hola'));
    expect(screen.queryByRole('button', { name: 'Translate' })).toBeNull();
  });

  it('puts them in the More panel on phones', async () => {
    device.isMobile = true;
    act(() => setPluginActions('p', 'Translator', 'reader-actions', [{ id: 'translate', label: 'Translate' }]));
    viewer(textMail('Hola'));

    expect(screen.queryByRole('button', { name: 'Translate' })).toBeNull();
    // The panel's entries are there from its first open on.
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const item = screen.getByRole('menuitem', { name: 'Translate', hidden: true });
    await act(async () => { fireEvent.click(item); });
    expect(dispatch).toHaveBeenCalledWith('p', 'reader-actions', 'translate', { emailId: 'e1' });
  });

  it('draws nothing without a plugin', () => {
    const { container } = viewer(textMail('Hola'));
    expect(container.querySelector('[data-plugin-actions="reader-actions"]')).toBeNull();
  });
});

describe('attachment-actions', () => {
  const withAttachment = () => textMail('See attached', {
    hasAttachment: true,
    attachments: [{ partId: '2', blobId: 'blob-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 1234, disposition: 'attachment' }],
  } as Partial<Email>);

  it('puts the frames next to the chip, not in its hover overlay', () => {
    offerSlots('p1', ['attachment-actions']);
    viewer(withAttachment());

    // Desktop chip and phone chip are both in the DOM.
    const frames = screen.getAllByTestId('slot-attachment-actions');
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      // Nothing between the frame and the page may hide it until hover.
      for (let el: HTMLElement | null = frame; el; el = el.parentElement) {
        expect(el.className).not.toMatch(/\bopacity-0\b/);
      }
      expect(frame.closest('[data-attachment-name]')).toBeNull();
      expect(slotProps(frame)).toEqual({
        attachment: { name: 'invoice.pdf', type: 'application/pdf', size: 1234, blobId: 'blob-pdf', emailId: 'e1' },
      });
    }
  });

  // Only the cards below the message hide their buttons until hover.
  const cardOverlays = () => {
    useSettingsStore.setState({ attachmentPosition: 'below-message' });
    viewer(withAttachment());
    const overlays = [...document.querySelectorAll<HTMLElement>('[data-attachment-name="invoice.pdf"] div')]
      .filter((d) => /\bopacity-0\b/.test(d.className));
    expect(overlays.length).toBeGreaterThan(0);
    return overlays;
  };

  it('keeps the invisible hover overlay from taking taps', () => {
    for (const overlay of cardOverlays()) {
      expect(overlay.className).toMatch(/\bpointer-events-none\b/);
      expect(overlay.className).toMatch(/\bgroup-hover:pointer-events-auto\b/);
      // Touch screens show the buttons all the time, so they must take taps there.
      expect(overlay.className).toMatch(/\[@media\(hover:none\)\]:pointer-events-auto/);
    }
  });

  it("shows the overlay's buttons to keyboard users who tab into them, not only on hover", () => {
    for (const overlay of cardOverlays()) {
      expect(overlay.className).toMatch(/\bgroup-focus-within:opacity-100\b/);
      expect(overlay.className).toMatch(/\bgroup-focus-within:pointer-events-auto\b/);
    }
  });
});

describe('attachment-menu', () => {
  const withAttachments = () => textMail('See attached', {
    hasAttachment: true,
    attachments: [
      { partId: '2', blobId: 'blob-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 1234, disposition: 'attachment' },
      { partId: '3', blobId: 'blob-png', name: 'photo.png', type: 'image/png', size: 99, disposition: 'attachment' },
    ],
  } as Partial<Email>);

  it('opens the plugin entries from a menu button on the attachment and sends the attachment', async () => {
    act(() => setPluginActions('p', 'Cloud', 'attachment-menu', [{ id: 'save', label: 'Save to cloud', mimeTypes: ['application/pdf'] }]));
    viewer(withAttachments());

    // Only the PDF gets the menu (desktop chip and phone chip are both in the DOM).
    const buttons = document.querySelectorAll('[data-attachment-plugin-menu]');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.closest('[data-attachment-name]')?.getAttribute('data-attachment-name')).toBe('invoice.pdf');
    }
    fireEvent.click(buttons[0]);
    const item = await screen.findByRole('menuitem', { name: 'Save to cloud' });
    await act(async () => { fireEvent.click(item); });
    expect(dispatch).toHaveBeenCalledWith('p', 'attachment-menu', 'save', {
      emailId: 'e1', blobId: 'blob-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 1234,
    });
  });

  it('adds the menu to attachments in a conversation message', () => {
    act(() => setPluginActions('p', 'Cloud', 'attachment-menu', [{ id: 'save', label: 'Save to cloud' }]));
    const email = withAttachments();
    const thread = { threadKey: 't1', latestEmail: email, emails: [email], emailCount: 1 } as unknown as ThreadGroup;
    render(<ThreadConversationView thread={thread} emails={[email]} onBack={() => {}} />);

    expect(document.querySelectorAll('[data-attachment-plugin-menu]')).toHaveLength(2);
  });

  it('draws no menu button without a plugin entry', () => {
    viewer(withAttachments());
    expect(document.querySelector('[data-attachment-plugin-menu]')).toBeNull();
  });
});
