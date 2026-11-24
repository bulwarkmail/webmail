import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import { encodeRemoteUrl } from '@/lib/remote-content-proxy';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';

// #1021: with the admin policy's remoteContentProxyEnabled gate on, remote
// pictures the user allowed load from /api/remote-content on the webmail's
// own origin, and the frame's CSP allows pictures only from there. Whether
// they load is still the user's choice: blocked until "Load" as before.

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
const { ThreadConversationView } = await import('../thread-conversation-view');

const PIXEL = 'https://track.shop.example/pixel.gif?u=42';
const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const email = {
  id: 'e1', blobId: 'b-e1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'News', email: 'news@shop.example' }], to: [{ email: 'me@example.org' }],
  subject: 'Offer', receivedAt: '2026-10-01T10:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: `<p>Hello</p><img src="${PIXEL}"><table><tr><td background="https://cdn.shop.example/bg.png">x</td></tr></table>` } },
} as unknown as Email;

const proxyFolder = `${window.location.origin}/api/remote-content/`;
const proxied = (url: string) => `${proxyFolder}${encodeRemoteUrl(url)}`;

function setProxyGate(on: boolean) {
  usePolicyStore.setState((s) => ({ policy: { ...s.policy, features: { ...s.policy.features, remoteContentProxyEnabled: on } } }));
}

function frame(container: HTMLElement) {
  const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(srcdoc)?.[1] ?? '';
  const imgSrc = /img-src ([^;]*)/.exec(csp)?.[1] ?? '';
  return { srcdoc, imgSrc };
}

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

beforeEach(() => setNoThirdPartyTraffic(false));
afterEach(() => {
  setProxyGate(false);
  useSettingsStore.setState({ externalContentPolicy: 'ask' });
});

describe('reading pane', () => {
  it('loads allowed remote pictures through this server with the gate on', async () => {
    setProxyGate(true);
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    const { container } = render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await settle();
    const { srcdoc, imgSrc } = frame(container);
    expect(srcdoc).toContain(`src="${proxied(PIXEL)}"`);
    expect(srcdoc).toContain(`background="${proxied('https://cdn.shop.example/bg.png')}"`);
    expect(srcdoc).not.toContain('="https://track.shop.example');
    expect(imgSrc.split(' ')).toEqual(['data:', 'blob:', proxyFolder]);
  });

  it('still waits for "Load" under "ask", then loads through this server', async () => {
    setProxyGate(true);
    const { container } = render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await settle();
    expect(frame(container).srcdoc).not.toContain(proxyFolder);
    expect(frame(container).imgSrc).toBe('data: blob:');
    fireEvent.click(await screen.findByText('load_external_content'));
    await settle();
    expect(frame(container).srcdoc).toContain(`src="${proxied(PIXEL)}"`);
  });

  it('loads straight from the sender with the gate off, as before', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    const { container } = render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await settle();
    const { srcdoc, imgSrc } = frame(container);
    expect(srcdoc).toContain(`src="${PIXEL.replace('&', '&amp;')}"`);
    expect(srcdoc).not.toContain(proxyFolder);
    expect(imgSrc).toContain('https:');
  });
});

describe('conversation view', () => {
  it('loads allowed remote pictures through this server with the gate on', async () => {
    setProxyGate(true);
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    const { container } = render(
      <ThreadConversationView thread={{ threadId: 't1', emails: [email], latestEmail: email } as never} emails={[email] as never} onBack={() => {}} />,
    );
    await settle();
    const { srcdoc, imgSrc } = frame(container);
    expect(srcdoc).toContain(`src="${proxied(PIXEL)}"`);
    expect(srcdoc).not.toContain('="https://track.shop.example');
    expect(imgSrc.split(' ')).toEqual(['data:', 'blob:', proxyFolder]);
  });
});
