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
const { useCalendarStore } = await import('@/stores/calendar-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useSaveAsTemplateStore } = await import('@/stores/save-as-template-store');
const { DEFAULT_POLICY } = await import('@/lib/admin/types');

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
      'save_as_template', 'copy_message', 'copy_conversation', '|',
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

  it('is Save as… in the desktop app, which saves through the OS dialog, and the same action', () => {
    const onExport = vi.fn();
    window.bulwarkDesktop = { version: 1, platform: 'win32', saveAs: { begin: vi.fn(), write: vi.fn(), end: vi.fn() } } as never;
    try {
      const { result } = renderHook(() => useMessageActionList({ email, onExport }));
      const entries = result.current.filter((entry) => entry.kind === 'item' && entry.key === 'export');
      expect(entries.map((entry) => (entry.kind === 'item' ? entry.label : ''))).toEqual(['menu_save_as']);
      if (entries[0].kind === 'item') entries[0].run?.();
      expect(onExport).toHaveBeenCalledTimes(1);
    } finally {
      delete window.bulwarkDesktop;
    }
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

// #1781: Edit as new, for sent mail only.
describe('Edit as new', () => {
  const labels = (role: string | undefined, onEditAsNew?: () => void, keywords: Record<string, boolean> = { $seen: true }) => {
    const { result } = renderHook(() => useMessageActionList({
      email: { ...email, keywords } as Email,
      currentMailboxRole: role,
      onReply: () => {},
      onEditAsNew,
    }));
    return result.current.map((entry) => (entry.kind === 'separator' ? '|' : entry.label));
  };

  it('follows Forward in Sent and runs the handler', () => {
    const onEditAsNew = vi.fn();
    const { result } = renderHook(() => useMessageActionList({ email, currentMailboxRole: 'sent', onEditAsNew }));
    const entries = result.current.filter((entry) => entry.kind === 'item');
    const keys = entries.map((entry) => (entry.kind === 'item' ? entry.key : ''));
    expect(keys.indexOf('edit_as_new')).toBe(keys.indexOf('forward_as_attachment') + 1);
    const entry = entries.find((e) => e.kind === 'item' && e.key === 'edit_as_new');
    if (entry?.kind === 'item') entry.run();
    expect(onEditAsNew).toHaveBeenCalledTimes(1);
  });

  it('is not offered outside Sent, for a draft, or without a handler', () => {
    expect(labels('sent', vi.fn())).toContain('edit_as_new');
    expect(labels('inbox', vi.fn())).not.toContain('edit_as_new');
    expect(labels(undefined, vi.fn())).not.toContain('edit_as_new');
    expect(labels('sent', vi.fn(), { $draft: true })).not.toContain('edit_as_new');
    expect(labels('sent')).not.toContain('edit_as_new');
  });

  it("is in the row menu's top level in Sent", () => {
    const onEditAsNew = vi.fn();
    const onClose = vi.fn();
    render(
      <EmailContextMenu
        email={{ ...email, mailboxIds: { sent: true } } as Email}
        position={{ x: 10, y: 10 }}
        isOpen
        onClose={onClose}
        menuRef={{ current: null }}
        mailboxes={[...mailboxes, { id: 'sent', name: 'Sent', role: 'sent', parentId: null, myRights: { mayAddItems: true } } as unknown as Mailbox]}
        selectedMailbox="sent"
        currentMailboxRole="sent"
        onEditAsNew={onEditAsNew}
      />,
    );
    fireEvent.click(screen.getByTestId('ctx-edit-as-new'));
    expect(onEditAsNew).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("is in the reader's ⋮ in Sent", () => {
    const onEditAsNew = vi.fn();
    renderViewer({ currentMailboxRole: 'sent', onEditAsNew });
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const menu = screen.getByRole('menu', { name: 'more_actions' });
    fireEvent.click(within(menu).getByTestId('ctx-edit-as-new'));
    expect(onEditAsNew).toHaveBeenCalledTimes(1);
  });
});

// #1579: a new event in the calendar, filled in from the message.
describe('Create event', () => {
  afterEach(() => {
    useCalendarStore.setState({ supportsCalendar: false });
    sessionStorage.clear();
  });

  const entryOf = (message: Email) => {
    const { result } = renderHook(() => useMessageActionList({ email: message, onReply: () => {} }));
    return result.current.find((entry) => entry.kind === 'item' && entry.key === 'create_event');
  };

  it('parks a draft from the message for the calendar', () => {
    useCalendarStore.setState({ supportsCalendar: true });
    const entry = entryOf(email);
    expect(entry).toBeTruthy();
    if (entry?.kind === 'item') entry.run();
    const parked = JSON.parse(sessionStorage.getItem('bulwark:pending-event-draft') ?? '{}');
    expect(parked.draft).toMatchObject({ title: 'Hello' });
    // The text, then the line with the link back (its words come from the locale).
    expect(parked.draft.description).toBe('Hello\n\nlink_line');
  });

  it('is not offered without a calendar, or on a draft', () => {
    expect(entryOf(email)).toBeUndefined();
    useCalendarStore.setState({ supportsCalendar: true });
    expect(entryOf({ ...email, keywords: { $draft: true } } as Email)).toBeUndefined();
  });
});

// #1885: the reader's ⋮ deletes the whole conversation, right under Delete.
describe('Delete conversation', () => {
  const items = (role: string, onDeleteConversation?: () => void) => {
    const { result } = renderHook(() => useMessageActionList({ email, currentMailboxRole: role, onDelete: () => {}, onDeleteConversation }));
    return result.current.flatMap((entry) => (entry.kind === 'item' ? [entry] : []));
  };

  it('follows Delete, says "forever" in Trash, and runs the handler', () => {
    const onDeleteConversation = vi.fn();
    const inbox = items('inbox', onDeleteConversation);
    const keys = inbox.map((entry) => entry.key);
    expect(keys.indexOf('delete_conversation')).toBe(keys.indexOf('delete') + 1);
    const entry = inbox.find((e) => e.key === 'delete_conversation')!;
    expect(entry.label).toBe('delete_conversation');
    expect(entry.destructive).toBe(true);
    entry.run();
    expect(onDeleteConversation).toHaveBeenCalledTimes(1);
    expect(items('trash', vi.fn()).find((e) => e.key === 'delete_conversation')!.label).toBe('delete_conversation_forever');
  });

  it('is not offered without a handler', () => {
    expect(items('inbox').some((e) => e.key === 'delete_conversation')).toBe(false);
  });

  it("is in the reader's ⋮ on a desktop, where Delete is on the toolbar", () => {
    const onDeleteConversation = vi.fn();
    renderViewer({ onDeleteConversation });
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const menu = screen.getByRole('menu', { name: 'more_actions' });
    expect(within(menu).queryByTestId('ctx-delete')).toBeNull();
    fireEvent.click(within(menu).getByTestId('ctx-delete-conversation'));
    expect(onDeleteConversation).toHaveBeenCalledTimes(1);
  });

  it("is in the phone's More panel", () => {
    device.isMobile = true;
    const onDeleteConversation = vi.fn();
    renderViewer({ onDeleteConversation });
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    const panel = screen.getByRole('menu', { name: 'more_actions' });
    fireEvent.click(within(panel).getByTestId('panel-delete_conversation'));
    expect(onDeleteConversation).toHaveBeenCalledTimes(1);
  });

  it("is not in a list row's menu", () => {
    render(
      <EmailContextMenu
        rowMenu
        email={email}
        position={{ x: 10, y: 10 }}
        isOpen
        onClose={vi.fn()}
        menuRef={{ current: null }}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ctx-delete')).toBeTruthy();
    expect(screen.queryByTestId('ctx-delete-conversation')).toBeNull();
  });
});

// Save as template from a message: the menus ask; the host in the layout reads it.
describe('Save as template', () => {
  const entryOf = (message: Email) => {
    const { result } = renderHook(() => useMessageActionList({ email: message, onReply: () => {} }));
    return result.current.find((entry) => entry.kind === 'item' && entry.key === 'save_as_template');
  };

  afterEach(() => {
    usePolicyStore.setState({ policy: DEFAULT_POLICY });
    useSaveAsTemplateStore.getState().close();
  });

  it('asks the host to save the message as a template', () => {
    const entry = entryOf(email);
    expect(entry).toBeTruthy();
    if (entry?.kind === 'item') entry.run();
    expect(useSaveAsTemplateStore.getState().pending?.email).toBe(email);
  });

  it("is in the reader's ⋮ and in the row menu's More actions", () => {
    renderViewer();
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'more_actions' })).getByTestId('ctx-save-as-template'));
    expect(useSaveAsTemplateStore.getState().pending?.email.id).toBe('e1');
  });

  it('is not offered where the admin hid personal templates', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, restrictions: { personalTemplates: { hidden: true } } } });
    expect(entryOf(email)).toBeUndefined();
  });
});
