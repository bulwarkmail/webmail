// The mobile conversation view built its own sanitizer hook, which caught
// only <img src> and inline style url(), and a CSP that always allowed
// http:/https: images - so with remote content blocked (default policy
// 'ask') srcset, background attributes, posters and <source> still loaded.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const t = Object.assign((k: string) => k, { raw: (k: string) => k, rich: (k: string) => k });
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));

const TRACKERS = ['upper.gif', 'srcset.gif', 'bgattr.gif', 'poster.gif', 'source.gif'];
const HTML = `
<p>hello</p>
<img src="HTTPS://t.example/upper.gif">
<img srcset="https://t.example/srcset.gif 1x">
<table background="https://t.example/bgattr.gif"><tr><td>x</td></tr></table>
<video poster="https://t.example/poster.gif"></video>
<picture><source srcset="https://t.example/source.gif"><img alt="p"></picture>
`;

describe('conversation view honours the remote-content block', () => {
  it('emits no live tracker URL and a strict img-src while blocked', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    expect(useSettingsStore.getState().externalContentPolicy).toBe('ask');
    const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
    const email = {
      id: 'e1', threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
      from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
      subject: 's', receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hello', hasAttachment: false,
      htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], attachments: [],
      bodyValues: { '1': { value: HTML } },
    };
    const { container } = render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails: [email], latestEmail: email } as never}
        emails={[email] as never}
        onBack={() => {}}
      />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const srcdoc = iframe!.getAttribute('srcdoc') ?? '';
    // A live attribute, not the inert data-blocked-* copy the blocker keeps.
    const live = TRACKERS.filter((name) => new RegExp(`\\s(src|srcset|background|poster)="[^"]*${name.replace('.', '\\.')}`, 'i').test(srcdoc));
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(srcdoc)?.[1] ?? '';
    expect(live).toEqual([]);
    expect(csp).not.toMatch(/img-src[^;]*https?:/);
  }, 30_000);
});
