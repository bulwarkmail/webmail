import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Conversation view: each message frame has its own name and language, and
// the reading settings reach every message body.

const t = Object.assign(
  (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  { raw: (key: string) => key, rich: (key: string) => key, has: () => true },
);
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));

const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
const { useSettingsStore } = await import('@/stores/settings-store');
const { ACCESSIBILITY_DEFAULTS } = await import('@/lib/accessibility-settings');

function mail(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
    from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
    subject: `Subject ${id}`, receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hello', hasAttachment: false,
    htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], attachments: [],
    bodyValues: { '1': { value: '<p>hello <b>there</b></p>' } },
    ...extra,
  };
}

function show(emails: ReturnType<typeof mail>[]) {
  const latest = emails[emails.length - 1];
  return render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails, latestEmail: latest } as never}
      emails={emails as never}
      onBack={() => {}}
    />,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium' } as never);
});

describe('conversation message frames', () => {
  it('are named after their own subject and carry the body language', () => {
    const { container } = show([mail('a', { htmlBody: [{ partId: '1', type: 'text/html', language: ['it'] }] })]);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('title')).toBe('email_viewer.frame_title {"subject":"Subject a"}');
    expect(iframe.getAttribute('srcdoc')).toMatch(/<html lang="it"/);
    expect(screen.queryByTitle('Email content')).toBeNull();
  });
});

describe('conversation controls name their target', () => {
  it('card headers say whether they are expanded', () => {
    show([mail('a'), mail('b')]);
    const headers = screen.getAllByText('Sender').map((el) => el.closest('button'));
    expect(headers.map((h) => h?.getAttribute('aria-expanded')).sort()).toEqual(['false', 'true']);
  });

  it('attachment buttons include the file name', () => {
    show([mail('a', {
      hasAttachment: true,
      attachments: [{ partId: '2', blobId: 'blob2', name: 'report.pdf', type: 'application/pdf', size: 2048 }],
    })]);
    expect(screen.getByRole('button', { name: /^(email_viewer\.download|files\.preview) report\.pdf/ })).toBeInTheDocument();
  });
});

describe('conversation message text size', () => {
  it('plain text follows the mail text size instead of a fixed 13px', () => {
    useSettingsStore.setState({ mailTextScale: 2 } as never);
    show([mail('a', { htmlBody: [], textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { '1': { value: 'just text' } } })]);
    const body = screen.getByText('just text').closest('[data-plugin-source="email-body"]') as HTMLElement;
    expect(body.style.fontSize).toMatch(/0\.8125rem \* 2|1\.625rem/);
  });

  it('plain text is centred at about 80 characters a line when the reading width is comfortable', () => {
    useSettingsStore.setState({ readingWidth: 'comfortable' } as never);
    show([mail('a', { htmlBody: [], textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { '1': { value: 'just text' } } })]);
    const body = screen.getByText('just text').closest('[data-plugin-source="email-body"]') as HTMLElement;
    expect(body.style.maxWidth).toBe('80ch');
    expect(body.style.marginInline).toBe('auto');
  });
});

describe('conversation messages as plain text', () => {
  it('show HTML mail as text when plain text is the default', () => {
    useSettingsStore.setState({ mailViewMode: 'plain' } as never);
    const { container } = show([mail('a', { bodyValues: { '1': { value: '<p>Visit <a href="https://ex.com/x">our site</a></p>' } } })]);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-plugin-source="email-body"]')!.textContent).toContain('Visit our site (https://ex.com/x)');
  });
});
