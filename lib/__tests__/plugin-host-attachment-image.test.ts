import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
const exif = vi.hoisted(() => ({ read: vi.fn(() => ({ taken: '2026-10-31T14:05:30', lat: 52.52, lon: 13.4 })) }));
vi.mock('@/lib/exif', () => ({ readPhotoExif: exif.read }));

import { dispatchApiCall, PERM_PER_METHOD } from '../plugin-sandbox/host-api';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { snapshotHostFeatures } from '../plugin-sandbox/host-features';
import { withAssistantRuntime } from '../plugin-sandbox/assistant/runtime';

// jsdom can't decode or draw images: createImageBitmap and OffscreenCanvas
// are stood in for. A "picture" is a blob holding its size as JSON.

function plugin(perms: string[], id = 'ai-assistant'): InstalledPlugin {
  return {
    id, name: 'AI Assistant', version: '2.2.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const ASSISTANT = plugin(['email:read', 'email:blob-read']);
const call = (p: InstalledPlugin, ...args: unknown[]) => dispatchApiCall(p, 'email.getAttachmentImage', args);

const parts = {
  photo: { partId: '2', blobId: 'blob-photo', name: 'whiteboard.jpg', type: 'image/jpeg', size: 30 },
  logo: { partId: '3', blobId: 'blob-logo', name: 'logo.png', type: 'image/png', size: 30, disposition: 'inline', cid: '<logo1@aa>' },
  pixel: { partId: '4', blobId: 'blob-pixel', name: 'p.gif', type: 'image/gif', size: 30, disposition: 'inline', cid: 'px@aa' },
  pdf: { partId: '5', blobId: 'blob-pdf', name: 'agenda.pdf', type: 'application/pdf', size: 30 },
  svg: { partId: '6', blobId: 'blob-svg', name: 'chart.svg', type: 'image/svg+xml', size: 30 },
  huge: { partId: '7', blobId: 'blob-huge', name: 'raw.tif', type: 'image/tiff', size: 21 * 1024 * 1024 },
};
const SIZES: Record<string, { w: number; h: number }> = {
  'blob-photo': { w: 3000, h: 2000 }, 'blob-logo': { w: 240, h: 160 }, 'blob-pixel': { w: 1, h: 1 },
};

const message = {
  id: 'm1', threadId: 't1', mailboxIds: { inbox: true }, keywords: {}, subject: 'Logo', receivedAt: '2026-05-01T10:00:00Z',
  htmlBody: [{ partId: '1', blobId: 'b-html', size: 1, type: 'text/html' }],
  bodyValues: { 1: { value: '<p><img src="cid:logo1@aa" alt="Orange logo with a stripe"><img src="cid:px@aa"><img src="https://tracker.example.com/t.gif"></p>' } },
  attachments: Object.values(parts),
} as unknown as Email;

class FakeCanvas {
  constructor(public width: number, public height: number) {}
  getContext() {
    return { drawImage() {}, fillRect() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) };
  }
  async convertToBlob({ type }: { type: string }) { return new Blob([new Uint8Array([104, 105])], { type }); }
}

let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  resetPluginRateLimits();
  exif.read.mockClear();
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
    const { w, h } = JSON.parse(await blob.text()) as { w: number; h: number };
    return { width: w, height: h, close() {} };
  }));
  client = {
    getEmail: vi.fn(async (id: string) => (id === 'm1' ? message : null)),
    fetchBlobArrayBuffer: vi.fn(async (blobId: string) => new TextEncoder().encode(JSON.stringify(SIZES[blobId] ?? { w: 0, h: 0 })).buffer),
    getAccountId: vi.fn(() => 'acc1'),
    getMailboxes: vi.fn(async () => []),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useEmailStore.setState({ selectedEmail: null, emails: [], mailboxes: [], selectedMailbox: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ client: null });
});

describe('api.email.getAttachmentImage', () => {
  it('is behind email:blob-read, offered in the runtime and announced in the host features', async () => {
    expect(PERM_PER_METHOD['email.getAttachmentImage']).toBe('email:blob-read');
    await expect(call(plugin(['email:read']), 'm1', 'blob-photo')).rejects.toThrow(/lacks permission "email:blob-read"/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(snapshotHostFeatures()).toMatchObject({ attachmentImages: true });
    const calls: unknown[][] = [];
    const api = withAssistantRuntime({} as { email?: { getAttachmentImage?: (...a: unknown[]) => unknown } }, async (method, args) => { calls.push([method, args]); return null; });
    await api.email?.getAttachmentImage?.('m1', 'blob-photo', { maxSide: 512 });
    expect(calls).toEqual([['email.getAttachmentImage', ['m1', 'blob-photo', { maxSide: 512 }]]]);
  });

  it('returns the photo shrunk to 1568 px as base64 JPEG, without EXIF unless asked', async () => {
    expect(await call(ASSISTANT, 'm1', 'blob-photo')).toEqual({
      name: 'whiteboard.jpg', type: 'image/jpeg', width: 1568, height: 1045, data: 'aGk=', status: 'ok',
    });
    expect(exif.read).not.toHaveBeenCalled();
    expect(await call(ASSISTANT, 'm1', 'blob-photo', { maxSide: 600, exif: true })).toMatchObject({
      width: 600, height: 400, exif: { taken: '2026-10-31T14:05:30', lat: 52.52, lon: 13.4 },
    });
    expect(exif.read).toHaveBeenCalledTimes(1);
  });

  it('gives an inline image its alt text and skips a tracking pixel', async () => {
    expect(await call(ASSISTANT, 'm1', 'blob-logo')).toMatchObject({ status: 'ok', alt: 'Orange logo with a stripe', width: 240, height: 160 });
    expect(await call(ASSISTANT, 'm1', 'blob-pixel')).toEqual({ name: 'p.gif', type: 'image/gif', width: 1, height: 1, data: '', status: 'tracker' });
  });

  it('answers unsupported for what is not a picture, SVG included, and too_big without downloading', async () => {
    expect(await call(ASSISTANT, 'm1', 'blob-pdf')).toMatchObject({ status: 'unsupported', data: '' });
    expect(await call(ASSISTANT, 'm1', 'blob-svg')).toMatchObject({ status: 'unsupported' });
    expect(await call(ASSISTANT, 'm1', 'blob-huge')).toMatchObject({ status: 'too_big' });
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a blob that is not an attachment of that message', async () => {
    await expect(call(ASSISTANT, 'm1', 'b-html')).rejects.toThrow(/not an attachment of this message/);
    await expect(call(ASSISTANT, 'missing', 'blob-photo')).rejects.toThrow(/no message with id "missing"/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('checks its options and allows 30 reads a minute', async () => {
    await expect(call(ASSISTANT, 'm1', 'blob-photo', { maxSide: 8000 })).rejects.toThrow(/maxSide must be a whole number from 64 to 2576/);
    await expect(call(ASSISTANT, 'm1', 'blob-photo', { exif: 'yes' })).rejects.toThrow(/exif must be true or false/);
    await expect(call(ASSISTANT, 'm1', 'blob-photo', { url: 'https://x' })).rejects.toThrow(/unknown property "url"/);
    for (let i = 0; i < 30; i++) await call(ASSISTANT, 'm1', 'blob-pdf');
    await expect(call(ASSISTANT, 'm1', 'blob-pdf')).rejects.toThrow(/too many reads/);
  });
});
