// WebKit never calls listeners on a frame document that may not run
// scripts, so the link gate the app adds to the message frame never ran in
// Safari: a link opened its raw address in a new tab. The frame's links now
// carry no href until the gate is wired, and where the listener is skipped
// they go through the open-link page or get none.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

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
const { resetLinkGateHolder } = await import('@/lib/link-gate-holder');
const { linkGateToken, requestLinkGate } = await import('@/lib/link-gate');
const { clearAllHooks, uiHooks } = await import('@/lib/plugin-hooks');

const BODY = '<p>hi</p><a id="web" href="https://site.example/a">web</a><a id="app" href="/settings/accounts">app</a>';

function renderConversation() {
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
  return container.querySelector('iframe')!;
}

/** Load the frame (jsdom does not load srcdoc) in a browser that skips its listeners. */
function loadAsWebKit(iframe: HTMLIFrameElement): Document {
  const srcdoc = iframe.getAttribute('srcdoc') ?? '';
  const doc = iframe.contentDocument!;
  vi.spyOn(doc, 'addEventListener').mockImplementation(() => {});
  doc.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(srcdoc)![1];
  fireEvent.load(iframe);
  return doc;
}

afterEach(() => {
  clearAllHooks();
  resetLinkGateHolder();
  vi.restoreAllMocks();
});

describe('message frame links where the frame listener is skipped', () => {
  it('hands the frame no link address before the gate is wired', () => {
    const srcdoc = renderConversation().getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('id="web"');
    expect(srcdoc).not.toMatch(/<a\b[^>]*\shref=/);
  });

  it('routes web links through the open-link page and opens what the link check says', async () => {
    uiHooks.onBeforeExternalLink.register('p1', () => ({ href: 'https://proxy.example/?u=a' }));
    const doc = loadAsWebKit(renderConversation());

    const web = doc.getElementById('web')!;
    const href = web.getAttribute('href') ?? '';
    expect(href).toMatch(/\/open-link#[0-9a-f]{32}$/);
    expect(web.getAttribute('target')).toBe('_blank');
    // A path inside the app gets no href at all.
    expect(doc.getElementById('app')!.hasAttribute('href')).toBe(false);

    const outcome = await new Promise((resolve) => {
      requestLinkGate(linkGateToken(new URL(href).hash), (o) => { if (o.kind !== 'checking') resolve(o); }, 2000);
    });
    expect(outcome).toEqual({ kind: 'open', href: 'https://proxy.example/?u=a' });
  });
});
