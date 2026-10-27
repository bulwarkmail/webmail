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

const BODY = '<p>hi</p><a id="web" href="https://site.example/a">web</a><a id="app" href="/settings/accounts">app</a>';

function renderBody() {
  const email = {
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
