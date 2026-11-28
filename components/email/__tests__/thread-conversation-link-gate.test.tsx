// The conversation view (phone threads, expanded conversations on desktop)
// forced target=_blank on every link in a message and left the click to the
// browser, so the reader's link gate never ran there: a plugin's
// onBeforeExternalLink veto or rewrite was skipped, and a relative link
// opened a webmail route of the sender's choosing in a new tab.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

const t = Object.assign((k: string) => k, { raw: (k: string) => k, rich: (k: string) => k });
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
const { clearAllHooks, uiHooks } = await import('@/lib/plugin-hooks');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useSidebarAppFramesStore } = await import('@/stores/sidebar-app-frames-store');

const BODY = '<p>hi</p><a id="web" href="https://site.example/a">web</a><a id="app" href="/settings/accounts">app</a>';

function renderBody(plain?: string) {
  const email = plain ? {
    id: 'e1', threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
    from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
    subject: 's', receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hi', hasAttachment: false,
    htmlBody: [{ partId: '1', type: 'text/plain' }], textBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
    bodyValues: { '1': { value: plain } },
  } : {
    id: 'e1', threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
    from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
    subject: 's', receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hi', hasAttachment: false,
    htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], attachments: [],
    bodyValues: { '1': { value: BODY } },
  };
  const { container } = render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails: [email], latestEmail: email } as never}
      emails={[email] as never}
      onBack={() => {}}
    />,
  );
  if (plain) return container as unknown as Document;
  const iframe = container.querySelector('iframe')!;
  // jsdom does not load srcdoc: put the sanitised body in by hand.
  const srcdoc = iframe.getAttribute('srcdoc') ?? '';
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(srcdoc)![1];
  fireEvent.load(iframe);
  return doc;
}

function click(el: Element): boolean {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

afterEach(() => {
  clearAllHooks();
  vi.restoreAllMocks();
});

describe('conversation view link gate', () => {
  it('opens web links through onBeforeExternalLink and never a path inside the app', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const hook = vi.fn(() => ({ href: 'https://proxy.example/?u=a' }));
    uiHooks.onBeforeExternalLink.register('p1', hook);
    const doc = renderBody();

    expect(click(doc.getElementById('app')!)).toBe(true);
    expect(click(doc.getElementById('web')!)).toBe(true);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith('https://proxy.example/?u=a', '_blank', 'noopener,noreferrer');
    expect(hook).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('sends a middle-click through the check too, with the link text', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const hook = vi.fn(() => false);
    uiHooks.onBeforeExternalLink.register('p1', hook);
    const doc = renderBody();

    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    doc.getElementById('web')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(hook).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://site.example/a', text: 'web' })));
    expect(open).not.toHaveBeenCalled();
  }, 30_000);

  it('opens nothing when a plugin stops the link', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const hook = vi.fn(() => false);
    uiHooks.onBeforeExternalLink.register('p1', hook);
    const doc = renderBody();

    expect(click(doc.getElementById('web')!)).toBe(true);
    await waitFor(() => expect(hook).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(open).not.toHaveBeenCalled();
  }, 30_000);
});

describe('conversation view link gate, more paths', () => {
  it('sends a link in a plain-text message through the check', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const hook = vi.fn(() => false);
    uiHooks.onBeforeExternalLink.register('p1', hook);
    const root = renderBody('Pay at https://pay.example/x now');
    const link = root.querySelector('[data-plugin-source="email-body"] a')!;
    expect(click(link)).toBe(true);
    await waitFor(() => expect(hook).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://pay.example/x', emailId: 'e1' })));
    expect(open).not.toHaveBeenCalled();
  }, 30_000);

  it('leaves a middle-click to the browser while no link check listens', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const doc = renderBody();
    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    doc.getElementById('web')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  }, 30_000);
});

// A link to an admin inline app's origin (a chat app's permalink) opens that
// app in its pane, at that address; a modifier, another origin or a user's own
// app keep the new tab.
describe('conversation view, a link to a sidebar app', () => {
  const POST = 'https://chat.example.com/team/pl/abc123';
  const appBody = `<a id="post" href="${POST}">post</a><a id="other" href="https://other.example.com/x">other</a>`;
  const chat = { id: 'chat', name: 'Chat', url: 'https://chat.example.com/', icon: 'Globe', openMode: 'inline' as const, showOnMobile: false };
  let shownApp: { src?: string; name: string } | null = null;

  function renderApp(apps: (typeof chat | { openMode: 'tab' })[]) {
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, defaultSidebarApps: apps as never } });
    shownApp = null;
    useSidebarAppFramesStore.setState({ frames: [], shown: null, hosts: [{ id: 7, show: (app) => { shownApp = app; } }] });
    const doc = renderBody();
    doc.body.innerHTML = appBody;
    return doc;
  }
  const press = (el: Element, init: MouseEventInit = {}, type = 'click') => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  afterEach(() => {
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, defaultSidebarApps: [] } });
    useSidebarAppFramesStore.setState({ frames: [], shown: null, hosts: [] });
    useSettingsStore.setState({ sidebarApps: [] });
  });

  it('opens the admin app at the post in its pane, no tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const doc = renderApp([chat]);
    expect(press(doc.getElementById('post')!)).toBe(true);
    await waitFor(() => expect(shownApp).toMatchObject({ src: POST, name: 'Chat' }));
    expect(open).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps a new tab for Ctrl / Cmd / Shift+click and another origin', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const doc = renderApp([chat]);
    press(doc.getElementById('post')!, { ctrlKey: true });
    press(doc.getElementById('post')!, { metaKey: true });
    press(doc.getElementById('post')!, { shiftKey: true });
    press(doc.getElementById('other')!);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(4));
    expect(open).toHaveBeenNthCalledWith(1, POST, '_blank', 'noopener,noreferrer');
    expect(open).toHaveBeenNthCalledWith(4, 'https://other.example.com/x', '_blank', 'noopener,noreferrer');
    expect(shownApp).toBeNull();
  }, 30_000);

  it("keeps a new tab for a tab-mode admin app and a user's own inline app", async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    useSettingsStore.setState({ sidebarApps: [{ ...chat, id: 'mine' }] });
    const doc = renderApp([{ ...chat, openMode: 'tab' }]);
    press(doc.getElementById('post')!);
    await waitFor(() => expect(open).toHaveBeenCalledWith(POST, '_blank', 'noopener,noreferrer'));
    expect(shownApp).toBeNull();
  }, 30_000);

  // The app is decided on the address the link check hands back, in the
  // HTML body and the plain-text one alike.
  it("follows the link check's rewrite onto the app's origin, in both bodies", async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    uiHooks.onBeforeExternalLink.register('p1', (ctx: { href: string }) =>
      (ctx.href.startsWith('https://other.example.com/') ? { href: POST } : { href: 'https://other.example.com/y' }));
    const doc = renderApp([chat]);
    press(doc.getElementById('other')!);
    await waitFor(() => expect(shownApp).toMatchObject({ src: POST }));
    // The app's own link rewritten elsewhere: a new tab.
    press(doc.getElementById('post')!);
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://other.example.com/y', '_blank', 'noopener,noreferrer'));

    shownApp = null;
    open.mockClear();
    const root = renderBody(`See https://other.example.com/x or ${POST}`);
    const [other, post] = root.querySelectorAll('[data-plugin-source="email-body"] a');
    expect(press(other)).toBe(true);
    await waitFor(() => expect(shownApp).toMatchObject({ src: POST }));
    expect(press(post)).toBe(true);
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://other.example.com/y', '_blank', 'noopener,noreferrer'));
  }, 30_000);

  it('asks the link check first, which may stop it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const hook = vi.fn(() => false);
    uiHooks.onBeforeExternalLink.register('p1', hook);
    const doc = renderApp([chat]);
    press(doc.getElementById('post')!);
    await waitFor(() => expect(hook).toHaveBeenCalledWith(expect.objectContaining({ href: POST })));
    await new Promise((r) => setTimeout(r, 20));
    expect(shownApp).toBeNull();
    expect(open).not.toHaveBeenCalled();
  }, 30_000);
});
