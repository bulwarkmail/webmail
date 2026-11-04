// mail-3: a key pressed after a click into an HTML message of a conversation
// stayed in the message's frame, so the mail shortcuts did nothing.
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

function renderHtmlMessage() {
  const email = {
    id: 'e1', threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
    from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
    subject: 's', receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hi', hasAttachment: false,
    htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], attachments: [],
    bodyValues: { '1': { value: '<p id="p">Newsletter</p>' } },
  };
  const { container } = render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails: [email], latestEmail: email } as never}
      emails={[email] as never}
      onBack={() => {}}
    />,
  );
  const iframe = container.querySelector('iframe')!;
  const srcdoc = iframe.getAttribute('srcdoc') ?? '';
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(srcdoc)![1];
  fireEvent.load(iframe);
  return doc;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('keys in a conversation message', () => {
  it('reach the page, where the shortcut handlers listen', () => {
    const doc = renderHtmlMessage();
    const heard: string[] = [];
    const listen = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener('keydown', listen);
    try {
      const FrameKeyboardEvent = (doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
      doc.getElementById('p')!.dispatchEvent(new FrameKeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true, cancelable: true }));
    } finally {
      window.removeEventListener('keydown', listen);
    }
    expect(heard).toEqual(['j']);
  });
});
