// A crypto plugin's render can be a key operation: with a smart card a dialog, and two
// PIN cancels in a row lock the key. So the render hook runs once per message, not once
// per object: mark-read replaces the object and changes nothing the hook gets to see.
// And a plugin can keep external content off for a body it can't vouch for (EFAIL).
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
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

const { renderHooks, clearAllHooks } = await import('@/lib/plugin-hooks');
const { usePluginRenderedBody, pluginRenderKey } = await import('@/hooks/use-plugin-rendered-body');
const { EmailViewer } = await import('../email-viewer');
const { ConversationEmailBody } = await import('../thread-conversation-view');

const REMOTE = 'https://tracker.example/x.png';
// The blocker keeps the address in an inert attribute, for "Load images". What matters is that it isn't a live one.
const LOADS_REMOTE = /<img[^>]*\ssrc="https:\/\/tracker/;
const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

const message = (over: Partial<Email> = {}) => ({
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: {},
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
  bodyStructure: { type: 'application/pkcs7-mime' },
  headers: { 'content-type': 'application/pkcs7-mime; smime-type=enveloped-data' },
  bodyValues: { '1': { value: 'Hello Bob', isTruncated: false } },
  ...over,
}) as unknown as Email;

const renders = () => {
  const handler = vi.fn(async () => ({ html: '', text: 'Decrypted', attachments: [], handledBy: 'smime' }));
  renderHooks.onRenderEmailBody.register('smime', handler as never);
  return handler;
};

const openViewer = (email: Email) => <EmailViewer email={email} mailboxes={mailboxes} />;

const originalDelay = useSettingsStore.getState().markAsReadDelay;
const originalPolicy = useSettingsStore.getState().externalContentPolicy;

beforeEach(() => {
  useSettingsStore.setState({ markAsReadDelay: -1 });
});

afterEach(() => {
  clearAllHooks();
  useSettingsStore.setState({ markAsReadDelay: originalDelay, externalContentPolicy: originalPolicy });
});

describe('pluginRenderKey', () => {
  it('ignores what the hook does not get: keywords and mailboxes', () => {
    expect(pluginRenderKey(message({ keywords: { $seen: true } }))).toBe(pluginRenderKey(message()));
    expect(pluginRenderKey(message({ mailboxIds: { archive: true } }))).toBe(pluginRenderKey(message()));
  });

  it('changes with the message and its blob', () => {
    expect(pluginRenderKey(message({ id: 'e2' }))).not.toBe(pluginRenderKey(message()));
    expect(pluginRenderKey(message({ blobId: 'b2' }))).not.toBe(pluginRenderKey(message()));
  });

  it('changes when the list row becomes the full message, which is what the hook decides on', () => {
    const row = message({ headers: undefined, bodyStructure: undefined, bodyValues: undefined });
    expect(pluginRenderKey(message())).not.toBe(pluginRenderKey(row));
  });

  it('changes when a truncated body arrives whole', () => {
    const whole = message({ bodyValues: { '1': { value: 'Hello Bob, and the rest', isTruncated: false } } as never });
    expect(pluginRenderKey(whole)).not.toBe(pluginRenderKey(message()));
  });
});

describe('usePluginRenderedBody', () => {
  it('runs the hook once when mark-read replaces the message object', async () => {
    const handler = renders();
    const { result, rerender } = renderHook(({ email }) => usePluginRenderedBody(email), { initialProps: { email: message() } });
    await waitFor(() => expect(result.current.text).toBe('Decrypted'));
    rerender({ email: message({ keywords: { $seen: true } }) });
    await act(async () => {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.current.text).toBe('Decrypted');
  });

  it('runs it again for an asked-for render, and for another message', async () => {
    const handler = renders();
    const { rerender } = renderHook(({ email }) => usePluginRenderedBody(email), { initialProps: { email: message() } });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await act(async () => { window.dispatchEvent(new CustomEvent('plugin:rerender-email')); });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    rerender({ email: message({ id: 'e2', blobId: 'b2' }) });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
  });

  it('says when the plugin wants external content off', async () => {
    renderHooks.onRenderEmailBody.register('smime', (async () => ({
      html: '<p>Body</p>', text: '', attachments: [], handledBy: 'smime', blockExternalContent: true,
    })) as never);
    const { result } = renderHook(() => usePluginRenderedBody(message()));
    await waitFor(() => expect(result.current.blockExternal).toBe(true));
  });

  it('leaves it to the settings otherwise', async () => {
    const handler = renders();
    const { result } = renderHook(() => usePluginRenderedBody(message()));
    await waitFor(() => expect(handler).toHaveBeenCalled());
    await waitFor(() => expect(result.current.text).toBe('Decrypted'));
    expect(result.current.blockExternal).toBe(false);
  });
});

describe('EmailViewer', () => {
  it('runs the hook once when mark-read replaces the message object', async () => {
    const handler = renders();
    const { rerender } = render(openViewer(message()));
    await screen.findByText('Decrypted');
    rerender(openViewer(message({ keywords: { $seen: true } })));
    await act(async () => {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Decrypted')).toBeTruthy();
  }, 30_000);

  it('runs it again when the list row becomes the full message', async () => {
    const handler = renders();
    const { rerender } = render(openViewer(message({ headers: undefined, bodyStructure: undefined })));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    rerender(openViewer(message()));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  }, 30_000);

  it('runs it again for an asked-for render', async () => {
    const handler = renders();
    render(openViewer(message()));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await act(async () => { window.dispatchEvent(new CustomEvent('plugin:rerender-email')); });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  }, 30_000);

  const remoteBody = (blockExternalContent?: boolean) => {
    renderHooks.onRenderEmailBody.register('smime', (async () => ({
      html: `<p>Secret body</p><img src="${REMOTE}">`, text: '', attachments: [], handledBy: 'smime',
      ...(blockExternalContent ? { blockExternalContent } : {}),
    })) as never);
  };
  const frameDoc = (container: HTMLElement) => container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

  it('keeps external content off when the plugin says so, whatever the settings allow', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    remoteBody(true);
    const { container } = render(openViewer(message()));
    await waitFor(() => expect(frameDoc(container)).toContain('Secret body'));
    expect(frameDoc(container)).not.toMatch(LOADS_REMOTE);
  }, 30_000);

  it('offers no way to load it then', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'ask' });
    remoteBody(true);
    const { container } = render(openViewer(message()));
    await waitFor(() => expect(frameDoc(container)).toContain('Secret body'));
    await act(async () => {});
    expect(screen.queryByTestId('external-content-notice')).toBeNull();
  }, 30_000);

  it('follows the settings for any other plugin body', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    remoteBody();
    const { container } = render(openViewer(message()));
    await waitFor(() => expect(frameDoc(container)).toContain('Secret body'));
    expect(frameDoc(container)).toMatch(LOADS_REMOTE);
  }, 30_000);
});

describe('ConversationEmailBody', () => {
  const body = (allowExternal: boolean, onAllowExternal = () => {}) => (
    <ConversationEmailBody email={message()} allowExternal={allowExternal} onAllowExternal={onAllowExternal} />
  );

  it('keeps external content off when the plugin says so, even with it allowed', async () => {
    renderHooks.onRenderEmailBody.register('smime', (async () => ({
      html: `<p>Secret body</p><img src="${REMOTE}">`, text: '', attachments: [], handledBy: 'smime', blockExternalContent: true,
    })) as never);
    const { container } = render(body(true));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').toContain('Secret body'));
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).not.toMatch(LOADS_REMOTE);
  }, 30_000);

  it('has no button to load it', async () => {
    renderHooks.onRenderEmailBody.register('smime', (async () => ({
      html: `<p>Secret body</p><img src="${REMOTE}">`, text: '', attachments: [], handledBy: 'smime', blockExternalContent: true,
    })) as never);
    const { container } = render(body(false));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').toContain('Secret body'));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /load_external_content|load/i })).toBeNull();
  }, 30_000);
});
