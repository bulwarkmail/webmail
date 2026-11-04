import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode, DragEvent } from 'react';
import { clearAllHooks, dragDropHooks, sidebarAppHooks, uiHooks } from '@/lib/plugin-hooks';
import { useUIStore } from '@/stores/ui-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { DragDropProvider, useDragDropContext } from '@/contexts/drag-drop-context';
import { useMailboxDrop } from '../use-mailbox-drop';
import { useTagDrop } from '../use-tag-drop';
import { useSidebarApps } from '../use-sidebar-apps';
import type { Email, Mailbox } from '@/lib/jmap/types';

function listen(bus: { register: (id: string, fn: (...a: unknown[]) => unknown) => unknown }) {
  const fn = vi.fn();
  bus.register('test', fn);
  return fn;
}

const wrapper = ({ children }: { children: ReactNode }) => <DragDropProvider>{children}</DragDropProvider>;

function dropEvent(ids: string[]): DragEvent<HTMLDivElement> {
  return {
    preventDefault() {}, stopPropagation() {},
    dataTransfer: { getData: () => JSON.stringify(ids) },
  } as unknown as DragEvent<HTMLDivElement>;
}

const EMAIL = { id: 'm1', mailboxIds: { inbox: true }, keywords: {} } as unknown as Email;

beforeEach(() => {
  clearAllHooks();
  useUIStore.setState({ activeView: 'list', sidebarOpen: false, sidebarCollapsed: false, isMobile: true, isCompact: false, isDesktop: false });
});

describe('layout hooks', () => {
  it('reports view, sidebar and device changes', () => {
    const view = listen(uiHooks.onViewChange);
    const toggle = listen(uiHooks.onSidebarToggle);
    const collapse = listen(uiHooks.onSidebarCollapse);
    const device = listen(uiHooks.onDeviceTypeChange);

    useUIStore.getState().showEmailViewer();
    useUIStore.getState().toggleSidebar();
    useUIStore.getState().setSidebarCollapsed(true);
    useUIStore.getState().setDeviceType(false, false, true);
    useUIStore.getState().setDeviceType(false, false, true);
    // A compact desktop is "tablet" to plugins.
    useUIStore.getState().setDeviceType(false, true, true);

    expect(view).toHaveBeenCalledWith({ view: 'viewer' });
    expect(toggle).toHaveBeenCalledWith({ open: true });
    expect(collapse).toHaveBeenCalledWith({ collapsed: true });
    expect(device.mock.calls).toEqual([[{ deviceType: 'desktop' }], [{ deviceType: 'tablet' }]]);
  });

  it('reports Back on the phone', () => {
    const back = listen(uiHooks.onMobileBack);

    useUIStore.getState().goBack();

    expect(back).toHaveBeenCalledTimes(1);
  });

  it('reports a column once the resize ends, not during the drag', () => {
    const resized = listen(uiHooks.onColumnResize);
    const start = useUIStore.getState().sidebarWidth;

    useUIStore.getState().setSidebarWidth(start + 10);
    useUIStore.getState().setSidebarWidth(start + 20);
    expect(resized).not.toHaveBeenCalled();
    useUIStore.getState().persistColumnWidths();

    expect(resized.mock.calls).toEqual([[{ column: 'sidebar', width: useUIStore.getState().sidebarWidth }]]);
  });
});

describe('drag and drop hooks', () => {
  beforeEach(() => {
    useAuthStore.setState({ client: {} as never });
    useEmailStore.setState({
      emails: [EMAIL], mailboxes: [], selectedEmailKeys: new Set(),
      moveEmailsToMailbox: vi.fn().mockResolvedValue(true),
      refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined),
      setEmailKeywords: vi.fn().mockResolvedValue(true),
      fetchEmails: vi.fn().mockResolvedValue(undefined),
      fetchTagCounts: vi.fn(),
      clearSelection: vi.fn(),
    } as never);
  });

  it('reports a drag of messages dropped on a folder', async () => {
    const started = listen(dragDropHooks.onDragStart);
    const ended = listen(dragDropHooks.onDragEnd);
    const dropped = listen(dragDropHooks.onEmailDrop);
    const target = { id: 'archive', myRights: { mayAddItems: true } } as unknown as Mailbox;
    const { result } = renderHook(
      () => ({ ctx: useDragDropContext(), drop: useMailboxDrop({ mailbox: target, onSuccess: () => {} }) }),
      { wrapper },
    );

    act(() => { result.current.ctx.startDrag([EMAIL], 'inbox'); });
    await act(async () => { await result.current.drop.dropHandlers.onDrop(dropEvent(['m1'])); });

    expect(started).toHaveBeenCalledWith({ kind: 'email', ids: ['m1'] });
    expect(dropped).toHaveBeenCalledWith({ emailIds: ['m1'], targetMailboxId: 'archive' });
    expect(ended.mock.calls).toEqual([[{ kind: 'email', ids: ['m1'], dropped: true }]]);
  });

  it('says nothing moved when a plugin stops the move', async () => {
    useEmailStore.setState({ moveEmailsToMailbox: vi.fn().mockResolvedValue(false) } as never);
    const dropped = listen(dragDropHooks.onEmailDrop);
    const onSuccess = vi.fn();
    const target = { id: 'archive', myRights: { mayAddItems: true } } as unknown as Mailbox;
    const { result } = renderHook(
      () => ({ ctx: useDragDropContext(), drop: useMailboxDrop({ mailbox: target, onSuccess }) }),
      { wrapper },
    );

    act(() => { result.current.ctx.startDrag([EMAIL], 'inbox'); });
    await act(async () => { await result.current.drop.dropHandlers.onDrop(dropEvent(['m1'])); });

    expect(dropped).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('reports a drag that ended without a drop', () => {
    const ended = listen(dragDropHooks.onDragEnd);
    const { result } = renderHook(() => useDragDropContext(), { wrapper });

    act(() => { result.current.startDrag([EMAIL], 'inbox'); });
    act(() => { result.current.endDrag(); });
    act(() => { result.current.endDrag(); });

    expect(ended.mock.calls).toEqual([[{ kind: 'email', ids: ['m1'], dropped: false }]]);
  });

  it('reports messages dropped on a tag', async () => {
    const tagged = listen(dragDropHooks.onTagDrop);
    const { result } = renderHook(
      () => ({ ctx: useDragDropContext(), drop: useTagDrop({ tagId: 'work', onSuccess: () => {} }) }),
      { wrapper },
    );

    act(() => { result.current.ctx.startDrag([EMAIL], 'inbox'); });
    await act(async () => { await result.current.drop.dropHandlers.onDrop(dropEvent(['m1'])); });

    expect(tagged).toHaveBeenCalledWith({ emailIds: ['m1'], keyword: '$label:work' });
  });

  it('says nothing was tagged when a plugin stops it', async () => {
    useEmailStore.setState({ setEmailKeywords: vi.fn().mockResolvedValue(false) } as never);
    const tagged = listen(dragDropHooks.onTagDrop);
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () => ({ ctx: useDragDropContext(), drop: useTagDrop({ tagId: 'work', onSuccess }) }),
      { wrapper },
    );

    act(() => { result.current.ctx.startDrag([EMAIL], 'inbox'); });
    await act(async () => { await result.current.drop.dropHandlers.onDrop(dropEvent(['m1'])); });

    expect(tagged).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('sidebar app hooks', () => {
  it('reports an app opening, and closing when the page goes away', () => {
    const opened = listen(sidebarAppHooks.onSidebarAppOpen);
    const closed = listen(sidebarAppHooks.onSidebarAppClose);
    // An app picked just before a reload opens on mount.
    sessionStorage.setItem('bulwark:pending-inline-app', JSON.stringify({ id: 'wiki', url: 'https://wiki.example.org', name: 'Wiki' }));
    const { unmount } = renderHook(() => useSidebarApps());

    expect(opened).toHaveBeenCalledWith({ appId: 'wiki' });
    expect(closed).not.toHaveBeenCalled();
    unmount();
    expect(closed).toHaveBeenCalledWith({ appId: 'wiki' });
  });

  it('reports an app the user closes', () => {
    const closed = listen(sidebarAppHooks.onSidebarAppClose);
    sessionStorage.setItem('bulwark:pending-inline-app', JSON.stringify({ id: 'wiki', url: 'https://wiki.example.org', name: 'Wiki' }));
    const { result } = renderHook(() => useSidebarApps());

    act(() => { result.current.closeInlineApp(); });

    expect(closed.mock.calls).toEqual([[{ appId: 'wiki' }]]);
  });
});
