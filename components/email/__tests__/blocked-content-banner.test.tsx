import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// #1639: a message whose body is already there when it opens showed its
// images blocked but no banner to load them. The banner flag was set during
// render and the reset effect for a new message cleared it afterwards; only
// a later re-render (a new `t`, a changed email object) brought it back.
// So `t` here is the same function on every render, as in the app.

const stable = vi.hoisted(() => {
  const t = (key: string) => key;
  const format = { dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) };
  return { t, format };
});
vi.mock('next-intl', () => ({
  useTranslations: () => stable.t,
  useLocale: () => 'en',
  useFormatter: () => stable.format,
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const message = (id: string, body: string) => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'News', email: 'news@shop.example' }], to: [{ email: 'me@example.org' }],
  subject: 'Offer', receivedAt: '2026-10-01T10:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: body } },
}) as unknown as Email;
const REMOTE = '<p>Hello</p><img src="https://cdn.shop.example/hero.jpg">';
const viewer = (email: Email) => (
  <EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />
);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

afterEach(() => {
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [] });
});

describe('blocked-content banner', () => {
  it('shows for a message opened with its body already loaded', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [] });
    render(viewer(message('e1', REMOTE)));
    await settle();
    expect(screen.getByTestId('external-content-notice')).toBeTruthy();
    expect(screen.getByText('load_external_content')).toBeTruthy();
  });

  it('shows again on the next message with remote content and not on one without', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [] });
    const view = render(viewer(message('e1', REMOTE)));
    await settle();
    view.rerender(viewer(message('e2', '<p>Plain</p>')));
    await settle();
    expect(screen.queryByTestId('external-content-notice')).toBeNull();
    view.rerender(viewer(message('e3', REMOTE)));
    await settle();
    expect(screen.getByTestId('external-content-notice')).toBeTruthy();
  });

  it('goes away once the images are loaded', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [] });
    const { container } = render(viewer(message('e1', REMOTE)));
    await settle();
    fireEvent.click(screen.getByText('load_external_content'));
    await settle();
    expect(screen.queryByTestId('external-content-notice')).toBeNull();
    expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').toMatch(/\ssrc="https:\/\/cdn\.shop\.example/);
  });
});
