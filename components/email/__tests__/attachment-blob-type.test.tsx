import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Attachments the reader holds as bytes (extracted from winmail.dat, or parts
// of an attached message) carry a type that is the sender's free text. A
// browser reads a Blob's type like a Content-Type header, where after a comma
// the last type counts, so "image/gif,text/html" is an HTML page once its
// blob: URL is opened on its own. Neither the thumbnail nor the chip may mint
// a blob: URL of such a type, and nothing of that type opens in a new tab.

vi.mock('@/lib/offline/availability', async (original) => ({
  ...(await original<typeof import('@/lib/offline/availability')>()),
  scopeDecided: () => true,
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

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { useAuthStore } = await import('@/stores/auth-store');

const LIST_TYPE = 'image/gif,text/html';
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const GIF = [...atob(GIF_BASE64)].map((c) => c.charCodeAt(0));

// A winmail.dat with one attachment whose MIME tag is LIST_TYPE (the writer
// mirrors lib/__tests__/tnef.test.ts).
class W {
  private bytes: number[] = [];
  u8(n: number) { this.bytes.push(n & 0xff); return this; }
  u16(n: number) { return this.u8(n).u8(n >>> 8); }
  u32(n: number) { return this.u8(n).u8(n >>> 8).u8(n >>> 16).u8(n >>> 24); }
  raw(arr: number[]) { for (const b of arr) this.u8(b); return this; }
  build() { return new Uint8Array(this.bytes); }
}
const enc = (s: string) => [...new TextEncoder().encode(s)];
const record = (w: W, level: number, id: number, data: number[]) => w.u8(level).u32(id).u32(data.length).raw(data).u16(0);
function mapiStringProp(propId: number, str: string): number[] {
  const w = new W();
  const val = enc(str);
  w.u32(1).u16(0x001e).u16(propId).u32(1).u32(val.length).raw(val);
  for (let i = 0; i < (4 - (val.length % 4)) % 4; i++) w.u8(0);
  return [...w.build()];
}
function winmailDat(): Uint8Array {
  const w = new W().u32(0x223e9f78).u16(0);
  record(w, 0x02, 0x00069002, [0, 0]);
  record(w, 0x02, 0x00018010, enc('invoice.gif\0'));
  record(w, 0x02, 0x0006800f, GIF);
  record(w, 0x02, 0x00069005, mapiStringProp(0x370e, LIST_TYPE));
  return w.build();
}

// An attached message with one part typed LIST_TYPE.
const ATTACHED_MESSAGE = [
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>',
  'Subject: Photos',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b2"',
  '',
  '--b2',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'See attached.',
  '--b2',
  `Content-Type: ${LIST_TYPE}; name="photo.gif"`,
  'Content-Disposition: attachment; filename="photo.gif"',
  'Content-Transfer-Encoding: base64',
  '',
  GIF_BASE64,
  '--b2--',
  '',
].join('\r\n');

const BLOBS: Record<string, Uint8Array> = {
  'tnef-1': winmailDat(),
  'msg-1': new TextEncoder().encode(ATTACHED_MESSAGE),
};

/** Answers fetchBlobArrayBuffer from BLOBS and anything else with nothing. */
const fakeClient = new Proxy({}, {
  get: (_target, name) => {
    if (name === 'then') return undefined;
    if (name === 'fetchBlobArrayBuffer') {
      return async (blobId: string) => {
        const bytes = BLOBS[blobId];
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      };
    }
    return () => undefined;
  },
});

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

function makeEmail(attachment: Record<string, unknown>, text: string): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: text, hasAttachment: true, size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
    attachments: [attachment], bodyValues: { 1: { value: text } },
  } as unknown as Email;
}

/** What a browser takes a Blob type for: the last comma-separated value, cut at the first space, ";" or "(". */
function browserEssence(type: string): string {
  const last = type.split(',').map((part) => part.trim()).filter(Boolean).pop() ?? '';
  return last.split(/[\s;(]/, 1)[0].toLowerCase();
}
const DOCUMENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']);

let minted: Map<string, Blob>;
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  minted = new Map();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:http://localhost/${minted.size + 1}`;
    minted.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  // A download is an <a download> click; jsdom cannot follow it.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  open = vi.fn(() => null);
  vi.stubGlobal('open', open);
  useAuthStore.setState({ activeAccountId: 'acct', client: fakeClient } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  useAuthStore.setState({ activeAccountId: null, client: null } as never);
});

async function clickChip(name: string): Promise<void> {
  const tile = await waitFor(() => {
    const found = screen.getAllByTestId('attachment').find((el) => el.getAttribute('data-attachment-name') === name);
    if (!found) throw new Error(`no chip for ${name}`);
    return found;
  });
  const before = minted.size;
  fireEvent.click(tile.querySelector('button')!);
  await waitFor(() => expect(minted.size).toBeGreaterThan(before));
}

function expectNothingOpensAsADocument(): void {
  expect(minted.size).toBeGreaterThan(0);
  for (const blob of minted.values()) {
    expect(blob.type).toMatch(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/);
    expect(DOCUMENT_TYPES.has(browserEssence(blob.type))).toBe(false);
  }
  for (const [url] of open.mock.calls as Array<[string]>) {
    const blob = minted.get(url);
    expect(blob && !DOCUMENT_TYPES.has(browserEssence(blob.type)) && !blob.type.includes(',')).toBe(true);
  }
}

describe('attachments the reader holds as bytes, typed as a list of types', () => {
  it('a winmail.dat entry gets no blob: URL of that type, as thumbnail or on a click', async () => {
    render(<EmailViewer email={makeEmail({ partId: '2', blobId: 'tnef-1', name: 'winmail.dat', type: 'application/ms-tnef', size: 200, disposition: 'attachment' }, 'Invoice attached.')} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onArchive={vi.fn()} onDelete={vi.fn()} />);
    await clickChip('invoice.gif');
    expectNothingOpensAsADocument();
  });

  it('a part of an attached message gets no blob: URL of that type, as thumbnail or on a click', async () => {
    render(<EmailViewer email={makeEmail({ partId: '2', blobId: 'msg-1', name: 'forwarded.eml', type: 'message/rfc822', size: 600, disposition: 'attachment' }, '')} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onArchive={vi.fn()} onDelete={vi.fn()} />);
    await clickChip('photo.gif');
    expectNothingOpensAsADocument();
  });
});
