import { render, renderHook, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// MAIL-25 / R6: one action list for a message. The row's menu, the reader's
// ⋮ and the phone's More panel show the same entries; Print, View source and
// Export work from the row, Pin and Copy to account from the reader.

const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { EmailContextMenu } = await import('../email-context-menu');
const { usePrintRequestStore, requestPrint } = await import('@/hooks/use-message-file-actions');
const { emailKeyFor } = await import('@/lib/thread-utils');
const { useMessageActionList } = await import('../message-actions');

const email = {
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
  textBody: [],
  htmlBody: [],
  attachments: [],
  bodyValues: {},
} as unknown as Email;

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'archive', name: 'Archive', role: 'archive', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function renderViewer(props: Partial<React.ComponentProps<typeof EmailViewer>> = {}) {
  return render(
    <EmailViewer
      email={email}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      onMoveToMailbox={vi.fn()}
      onSetTag={vi.fn()}
      onToggleStar={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />,
  );
}

afterEach(() => {
  device.isMobile = false;
  usePrintRequestStore.getState().setRequest(null);
  vi.restoreAllMocks();
});

describe('the row menu', () => {
  it('offers Export, Print and View source and runs them', () => {
    const onExport = vi.fn();
    const onPrint = vi.fn();
    const onViewSource = vi.fn();
    const onClose = vi.fn();
    render(
      <EmailContextMenu
        email={email}
        position={{ x: 10, y: 10 }}
        isOpen
        onClose={onClose}
        menuRef={{ current: null }}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        onExport={onExport}
        onPrint={onPrint}
        onViewSource={onViewSource}
      />,
    );
    fireEvent.click(screen.getByTestId('ctx-export'));
    fireEvent.click(screen.getByTestId('ctx-print'));
    fireEvent.click(screen.getByTestId('ctx-view-source'));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(onViewSource).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("the reader's ⋮ on a desktop", () => {
  it('is the row menu: a ContextMenu with the same entries, Pin included', () => {
    const onTogglePinned = vi.fn();
    renderViewer({ onTogglePinned });
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const menu = screen.getByRole('menu', { name: 'more_actions' });
    for (const id of ['ctx-move-to', 'ctx-tag', 'ctx-export', 'ctx-print', 'ctx-view-source']) {
      expect(within(menu).getByTestId(id)).toBeTruthy();
    }
    // Delete is on the toolbar already, and the star by the subject.
    expect(within(menu).queryByTestId('ctx-delete')).toBeNull();
    expect(within(menu).queryByTestId('ctx-star')).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'pin' }));
    expect(onTogglePinned).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu', { name: 'more_actions' })).toBeNull();
  });
});

describe("the reader's ⋮ in groups", () => {
  it("has the message's actions only, in groups", () => {
    renderViewer({ onTogglePinned: vi.fn(), onShowShortcuts: vi.fn() } as never);
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const menu = screen.getByRole('menu', { name: 'more_actions' });
    const rows = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]'))
      .map((row) => (row.getAttribute('role') === 'separator' ? '|' : row.querySelector('[data-menu-label]')?.textContent ?? ''));
    // No app-level entries: Import is in the folder's menu, Settings and the
    // palette, the shortcuts behind ?. Answer; file away; mark; spam; link;
    // how it shows; save.
    expect(rows).toEqual([
      'reply', 'reply_all', 'forward', 'forward_as_attachment', '|',
      'archive', '|',
      'move_to', '|',
      'mark_unread', 'pin', 'tag', '|',
      'mark_as_spam', '|',
      'copy_message', 'copy_conversation', '|',
      'reader_view', '|',
      'export_email', 'print', 'view_source',
    ]);
  });

  it('puts how the reader shows the message in a group before Export, Print and View source', () => {
    const { result } = renderHook(() => useMessageActionList({
      email,
      onExport: () => {},
      onPrint: () => {},
      views: [{ kind: 'item', key: 'extra:reader_view', icon: () => null, label: 'reader_view', run: () => {} }],
      extras: [{ kind: 'item', key: 'extra:other', icon: () => null, label: 'other', run: () => {} }],
    }));
    const labels = result.current.map((entry) => (entry.kind === 'separator' ? '|' : entry.label));
    expect(labels.slice(-7)).toEqual(['|', 'reader_view', '|', 'export_email', 'print', '|', 'other']);
  });
});

describe("the reader toolbar's Move and Tag menus", () => {
  it('are the ContextMenu: in a portal, with its rows and keys', () => {
    renderViewer();
    fireEvent.click(screen.getByRole('button', { name: 'move_to' }));
    const move = screen.getByRole('menu', { name: 'move_to' });
    expect(move.parentElement).toBe(document.body);
    fireEvent.keyDown(move, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'move_to' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'set_tag' }));
    expect(screen.getByRole('menu', { name: 'tag' }).parentElement).toBe(document.body);
  });
});

describe("the phone's More panel", () => {
  beforeEach(() => {
    device.isMobile = true;
  });

  it('lists the same entries as 44px rows, Pin and Export included', () => {
    const onTogglePinned = vi.fn();
    renderViewer({ onTogglePinned });
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const panel = screen.getByRole('menu', { name: 'more_actions' });
    const pin = within(panel).getByTestId('panel-pin');
    expect(pin.className).toContain('min-h-[44px]');
    // The star is by the subject, on the phone too.
    expect(within(panel).queryByTestId('panel-star')).toBeNull();
    for (const id of ['panel-export', 'panel-print', 'panel-view_source', 'panel-copy_message_link']) {
      expect(within(panel).getByTestId(id)).toBeTruthy();
    }
    fireEvent.click(pin);
    expect(onTogglePinned).toHaveBeenCalledTimes(1);
  });
});

describe('Print from the row', () => {
  it('opens the window in the click and the reader prints into it once the message is there', () => {
    const fakeWindow = {
      closed: false,
      opener: {} as unknown,
      document: { write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(fakeWindow as unknown as Window);
    expect(requestPrint(emailKeyFor(email))).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(fakeWindow.opener).toBeNull();

    renderViewer();
    act(() => {});
    expect(fakeWindow.document.write).toHaveBeenCalledTimes(1);
    expect(fakeWindow.print).toHaveBeenCalledTimes(1);
    // The reader didn't open a second window.
    expect(open).toHaveBeenCalledTimes(1);
    expect(usePrintRequestStore.getState().request).toBeNull();
  });

  it("leaves another message's print request alone", () => {
    const fakeWindow = { closed: false, opener: null, document: { write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(fakeWindow as unknown as Window);
    requestPrint('someone-else');
    renderViewer();
    expect(fakeWindow.print).not.toHaveBeenCalled();
    expect(usePrintRequestStore.getState().request?.key).toBe('someone-else');
  });
});
