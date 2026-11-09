import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { resetAccountSubjects, useAccountSubjects } from '@/lib/org/account-subjects';
import { remoteContentHeldBack } from '@/hooks/use-third-party-mode';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import { ResizableImage } from '../resizable-image';
import { serializeEditorContent } from '../quoted-html';

// The organisation's remote-content lock follows the account a message
// belongs to and holds while that account's scopes aren't known yet:
// - a lock in a domain or group scope (not only Everyone's), during the
//   window before the account's groups are known and while only the public
//   policy subset is in;
// - another signed-in account's message (unified inbox, Pro tab) under that
//   account's lock while the active account has none;
// - attachment previews (.eml) and remote images in a draft's own content.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');
const { EmlPreview } = await import('@/components/files/eml-preview');

const LOCK = { externalContentPolicy: { locked: true, value: 'block' } };
const lockedScope = { id: 'locked', label: 'Locked', match: { domains: ['locked.example'] }, policy: { restrictions: LOCK } };
const groupScope = { id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: { restrictions: LOCK } };

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const message = (account?: string) => ({
  id: 'e1', blobId: 'b-e1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'News', email: 'news@shop.example' }], to: [{ email: 'me@example.org' }],
  subject: 'Offer', receivedAt: '2026-10-01T10:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<p>Hello</p><img src="https://track.shop.example/pixel.gif">' } },
  ...(account ? { sourceClientAccountId: account, sourceAccountId: 'jmap-b' } : {}),
}) as unknown as Email;

function policy(scopes: unknown[], state: Record<string, unknown> = {}) {
  const raw = { ...DEFAULT_POLICY, scopes } as never;
  usePolicyStore.setState({ rawPolicy: raw, policy: DEFAULT_POLICY, loaded: true, fetching: false, partial: false, subjectPending: false, ...state });
}

afterEach(() => {
  cleanup();
  usePolicyStore.setState({ rawPolicy: DEFAULT_POLICY, policy: DEFAULT_POLICY, subject: null, subjectPending: false, partial: false, loaded: false, fetching: false });
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [] });
  useAuthStore.setState({ activeAccountId: null, getClientForAccount: () => undefined } as never);
  resetAccountSubjects();
});

describe('a lock in a scope', () => {
  it('holds while the active account’s groups are being worked out, then follows the scope', () => {
    policy([groupScope], { subject: null, subjectPending: true });
    expect(remoteContentHeldBack()).toBe(true);
    act(() => usePolicyStore.getState().setPolicySubject({ email: 'me@example.org', groups: [] }));
    // Not in the group: nothing held back.
    expect(remoteContentHeldBack()).toBe(false);
    act(() => usePolicyStore.getState().setPolicySubject({ email: 'me@example.org', groups: ['team@example.org'] }));
    expect(remoteContentHeldBack()).toBe(true);
  });

  it('holds while only the public part of the policy is in', () => {
    policy([lockedScope], { partial: true, subject: { email: 'me@example.org', groups: [] } });
    expect(remoteContentHeldBack()).toBe(true);
  });

  it('doesn’t hold without scopes once the policy is in', () => {
    policy([], { subject: null, subjectPending: true });
    expect(remoteContentHeldBack()).toBe(false);
  });
});

describe('another signed-in account’s message', () => {
  function twoAccounts() {
    const other = { getUsername: () => 'b@locked.example', getSharedAccounts: () => [], getAccountId: () => 'jmap-b', getBlobDownloadUrl: () => '', fetchBlob: async () => new Blob() };
    useAuthStore.setState({ activeAccountId: 'acct-a', getClientForAccount: (id: string) => (id === 'acct-b' ? other : undefined) } as never);
    policy([lockedScope], { subject: { email: 'a@free.example', groups: [] } });
    useAccountSubjects.setState({ subjects: { 'acct-b': { email: 'b@locked.example', groups: [] } }, settled: { 'acct-b': true } });
  }

  it('stays blocked under that account’s lock although the active account has none', async () => {
    twoAccounts();
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: ['news@shop.example'] });
    const { container } = render(<EmailViewer email={message('acct-b')} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect((await screen.findByTestId('external-content-notice')).textContent).toContain('remote_content_blocked');
    expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').not.toMatch(/\ssrc="https:\/\/track/);
  });

  it('loads for the active account’s own trusted sender', async () => {
    twoAccounts();
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: ['news@shop.example'] });
    const { container } = render(<EmailViewer email={message()} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('external-content-notice')).toBeNull();
    expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').toMatch(/\ssrc="https:\/\/track/);
  });

  it('holds while that account’s groups are still being worked out', () => {
    const other = { getUsername: () => 'b@x.example', getSharedAccounts: () => [] };
    useAuthStore.setState({ activeAccountId: 'acct-a', getClientForAccount: (id: string) => (id === 'acct-b' ? other : undefined) } as never);
    policy([groupScope], { subject: { email: 'a@free.example', groups: [] } });
    useAccountSubjects.setState({ subjects: {}, settled: {} });
    expect(remoteContentHeldBack('acct-b')).toBe(true);
    expect(remoteContentHeldBack()).toBe(false);
  });
});

describe('attachment previews', () => {
  it('keep an attached message’s images blocked until a scoped lock is known, even with "allow"', () => {
    setNoThirdPartyTraffic(false);
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    // Without the lock the image loads (the control).
    const open = render(<EmlPreview message={{ subject: 's', html: '<img src="https://t.example/p.gif">', attachments: [] }} />);
    expect(open.container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').toMatch(/\ssrc="https:\/\/t\.example/);
    cleanup();
    // The policy with a scope that may lock it isn't known for this account yet.
    policy([groupScope], { subject: null, subjectPending: true });
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    const { container } = render(<EmlPreview message={{ subject: 's', html: '<img src="https://t.example/p.gif">', attachments: [] }} />);
    expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').not.toMatch(/\ssrc="https:\/\/t\.example/);
  });
});

describe('remote images in a draft’s own content', () => {
  const HTML = '<p>Hi <img src="https://tracker.example/p.gif"></p>';

  it('are serialised without loading them in the app document', () => {
    const editor = new Editor({ extensions: [Document, Paragraph, Text, ResizableImage], content: HTML });
    const created: Element[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const el = original(tag, options);
      created.push(el);
      return el;
    }) as typeof document.createElement);
    const html = serializeEditorContent(editor);
    vi.restoreAllMocks();
    expect(html).toContain('src="https://tracker.example/p.gif"');
    expect(created.filter((el) => el.tagName === 'IMG' || el.querySelector('img'))).toEqual([]);
    editor.destroy();
  });

  it('are parked in the editor while the organisation blocks remote content', async () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, restrictions: LOCK as never }, loaded: true });
    function Box() {
      const editor = useEditor({ extensions: [Document, Paragraph, Text, ResizableImage], content: HTML, immediatelyRender: true });
      return <EditorContent editor={editor} />;
    }
    const { container } = render(<Box />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).not.toContain('tracker.example');
    expect(img?.hasAttribute('data-remote-parked')).toBe(true);
  });
});
