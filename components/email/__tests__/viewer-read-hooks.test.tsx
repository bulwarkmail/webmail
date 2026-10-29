import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { emailHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { composerHandle } from '@/lib/plugin-sandbox/composer-registry';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';

// mail-read hooks fired by the reading pane: onEmailContentRender once the
// body is on screen and onThreadExpand for the conversation cards. (The link
// hook runs inside the body iframe, which jsdom doesn't load; its decision is
// covered in lib/__tests__/plugin-hook-result.test.ts.)

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
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
const { ThreadConversationView } = await import('../thread-conversation-view');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const textEmail = (id = 'e1') => ({
  id, blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Hello there' } },
}) as unknown as Email;

const viewer = (email: Email, extra: Record<string, unknown> = {}) => (
  <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" {...extra} />
);

beforeEach(() => clearAllHooks());
afterEach(() => { cleanup(); act(() => { resetActions(); setActionDispatcher(null); }); });

/** Obtain the quick-reply handle through a generic plugin action click.
 * 범용 플러그인 작업 클릭으로 간단 답장의 핸들을 얻습니다. */
async function quickComposer() {
  const clicks: Record<string, unknown>[] = [];
  const send = vi.fn();
  setActionDispatcher(async (_plugin, _surface, _action, context) => { clicks.push(context); });
  setPluginActions('text-tools', 'Text tools', 'composer-toolbar-actions', [{ id: 'format', label: 'Format text' }]);
  const view = render(viewer({ ...textEmail(), replyTo: [] }, { onQuickReply: send }));
  const input = await screen.findByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'First second third' } });
  const button = await screen.findByRole('button', { name: 'Format text' });
  expect(button).not.toHaveClass('hidden');
  fireEvent.click(button);
  await waitFor(() => expect(clicks).toHaveLength(1));
  const id = clicks[0].composerId as string;
  return { input, handle: composerHandle(id)!, id, view, send, clicks };
}

describe('generic quick-reply composer actions', () => {
  it('provides the selected composer and unregisters it when the viewer closes', async () => {
    const { input, handle, id, view, send } = await quickComposer();
    expect(handle.readBody().text).toBe('First second third');
    expect(handle.readMetadata?.()).toMatchObject({ subject: 'Hello', to: ['alice@example.com'], attachments: [] });
    act(() => { expect(handle.replaceBody('', 'Formatted text')).toBe(true); });
    expect(input).toHaveValue('Formatted text');
    expect(send).not.toHaveBeenCalled();
    view.unmount();
    expect(composerHandle(id)).toBeNull();
  });

  it('inserts below a selection without removing the selected text', async () => {
    const { input, handle } = await quickComposer();
    input.setSelectionRange(6, 12);
    act(() => { expect(handle.replaceSelection('', 'Inserted', { below: true })).toBe(true); });
    expect(input).toHaveValue('First second\n\nInserted third');
  });

  it('replaces only the selection when below is false', async () => {
    const { input, handle } = await quickComposer();
    input.setSelectionRange(6, 12);
    act(() => { expect(handle.replaceSelection('', 'replacement', { below: false })).toBe(true); });
    expect(input).toHaveValue('First replacement third');
  });

  it('unregisters the handle when quick reply is hidden while loading', async () => {
    const { id, view } = await quickComposer();
    view.rerender(viewer(textEmail(), { isLoading: true }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(composerHandle(id)).toBeNull();
  });

  it('gives a new message its own capability instead of reusing the previous id', async () => {
    const { id, view, clicks } = await quickComposer();
    view.rerender(viewer(textEmail('e2')));
    expect(composerHandle(id)).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Format text' }));
    await waitFor(() => expect(clicks).toHaveLength(2));
    expect(clicks[1].composerId).not.toBe(id);
    expect(composerHandle(clicks[1].composerId)).not.toBeNull();
  });
});

describe('onEmailContentRender', () => {
  it('fires once the body is on screen, once per message', async () => {
    const handler = vi.fn();
    emailHooks.onEmailContentRender.register('test', handler);

    const { rerender } = render(viewer(textEmail(), { isLoading: true }));
    await act(async () => {});
    expect(handler).not.toHaveBeenCalled();

    rerender(viewer(textEmail(), { isLoading: false }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith({ emailId: 'e1', hasHtml: false, hasExternalContent: false });

    rerender(viewer(textEmail(), { isLoading: false, onReply: () => {} }));
    await act(async () => {});
    expect(handler).toHaveBeenCalledTimes(1);

    rerender(viewer(textEmail('e2'), { isLoading: false }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenLastCalledWith({ emailId: 'e2', hasHtml: false, hasExternalContent: false });
  });
});

describe('onThreadExpand in the conversation view', () => {
  it('reports a card being unfolded and folded', () => {
    const handler = vi.fn();
    emailHooks.onThreadExpand.register('test', handler);
    const older = { ...textEmail('old'), keywords: { $seen: true }, receivedAt: '2025-12-01T00:00:00Z' } as Email;
    const newer = textEmail('new');

    render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails: [newer, older], latestEmail: newer } as never}
        emails={[newer, older]}
        onBack={() => {}}
      />,
    );
    // The newest card starts unfolded, the older read one folded.
    const olderHeader = screen.getAllByText('Alice').at(-1)!;
    fireEvent.click(olderHeader);
    expect(handler).toHaveBeenLastCalledWith({ threadId: 't1', emailIds: ['old'], expanded: true });
    fireEvent.click(screen.getAllByText('Alice').at(-1)!);
    expect(handler).toHaveBeenLastCalledWith({ threadId: 't1', emailIds: ['old'], expanded: false });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
