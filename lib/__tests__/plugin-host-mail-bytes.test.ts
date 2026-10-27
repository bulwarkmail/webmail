import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall, MAX_PLUGIN_FETCH_BYTES } from '../plugin-sandbox/host-api';

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'archiver', name: 'Archiver', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const ARCHIVER = plugin(['email:blob-read']);
// Untrusted tier: no { privileged: true } here, which is the point.
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const invoice = { partId: '2', blobId: 'blob-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 3 };
const huge = { partId: '3', blobId: 'blob-big', name: 'big.iso', type: 'application/octet-stream', size: MAX_PLUGIN_FETCH_BYTES + 1 };

const message = {
  id: 'm1', threadId: 't1', blobId: 'blob-raw', size: 4, mailboxIds: { inbox: true }, keywords: {},
  subject: 'Invoice', receivedAt: '2026-05-01T10:00:00Z', attachments: [invoice, huge],
} as unknown as Email;

let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  client = {
    getEmail: vi.fn(async (id: string) => (id === 'm1' ? message : null)),
    fetchBlobArrayBuffer: vi.fn(async (blobId: string) => {
      if (blobId === 'blob-raw') return new TextEncoder().encode('From').buffer;
      return new Uint8Array([1, 2, 3]).buffer;
    }),
    getAccountId: vi.fn(() => 'acc1'),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useEmailStore.setState({ selectedEmail: null, emails: [], selectedMailbox: '' });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.email.getAttachment', () => {
  it('returns the bytes of an attachment of that message, to an untrusted plugin', async () => {
    const result = await call(ARCHIVER, 'email.getAttachment', 'm1', 'blob-pdf') as {
      name: string; type: string; size: number; data: ArrayBuffer;
    };
    expect(result.name).toBe('invoice.pdf');
    expect(result.type).toBe('application/pdf');
    expect(result.size).toBe(3);
    expect(result.data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(result.data)]).toEqual([1, 2, 3]);
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-pdf', 'invoice.pdf', 'application/pdf');
  });

  it('refuses a blob that is not an attachment of that message', async () => {
    await expect(call(ARCHIVER, 'email.getAttachment', 'm1', 'blob-raw')).rejects.toThrow(/not an attachment of this message/);
    await expect(call(ARCHIVER, 'email.getAttachment', 'm1', 'someone-elses-blob')).rejects.toThrow(/not an attachment/);
    await expect(call(ARCHIVER, 'email.getAttachment', 'missing', 'blob-pdf')).rejects.toThrow(/no message with id "missing"/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses attachments over 25 MB before downloading them', async () => {
    await expect(call(ARCHIVER, 'email.getAttachment', 'm1', 'blob-big')).rejects.toThrow(/larger than 26214400 bytes/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('needs email:blob-read, and string ids', async () => {
    await expect(call(plugin(['email:read']), 'email.getAttachment', 'm1', 'blob-pdf')).rejects.toThrow(/lacks permission "email:blob-read"/);
    await expect(call(ARCHIVER, 'email.getAttachment', 'm1', 7)).rejects.toThrow(/blobId must be a string/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });
});

describe('api.email.getRaw', () => {
  it('returns the message source from its own blob', async () => {
    const raw = await call(ARCHIVER, 'email.getRaw', 'm1') as ArrayBuffer;
    expect(new TextDecoder().decode(raw)).toBe('From');
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-raw', 'message.eml', 'message/rfc822');
  });

  it('refuses big messages, unknown ones and missing permission', async () => {
    client.getEmail.mockResolvedValueOnce({ ...message, size: MAX_PLUGIN_FETCH_BYTES + 1 });
    await expect(call(ARCHIVER, 'email.getRaw', 'm1')).rejects.toThrow(/larger than/);
    await expect(call(ARCHIVER, 'email.getRaw', 'missing')).rejects.toThrow(/no message/);
    await expect(call(plugin([]), 'email.getRaw', 'm1')).rejects.toThrow(/lacks permission "email:blob-read"/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('reads the source of the account a plugin names', async () => {
    // A group folder is open and its message has the same id as an own one.
    const group = { ...message, blobId: 'blob-group' } as Email;
    client.getEmail.mockImplementation(async (id: string, accountId?: string) => (
      id === 'm1' ? (accountId === 'grp' ? group : message) : null));
    useEmailStore.setState({
      mailboxes: [{ id: 'grp:inbox', originalId: 'inbox', name: 'Inbox', isShared: true, accountId: 'grp' } as never],
      selectedMailbox: 'grp:inbox',
      emails: [{ ...group, mailboxIds: { 'grp:inbox': true } } as Email],
      selectedEmail: { ...group, mailboxIds: { 'grp:inbox': true } } as Email,
    });

    await call(ARCHIVER, 'email.getRaw', 'm1', 'grp');
    expect(client.getEmail).toHaveBeenLastCalledWith('m1', 'grp');
    expect(client.fetchBlobArrayBuffer).toHaveBeenLastCalledWith('blob-group', 'message.eml', 'message/rfc822', 'grp');

    await call(ARCHIVER, 'email.getRaw', 'm1', 'acc1');
    expect(client.getEmail).toHaveBeenLastCalledWith('m1');
    expect(client.fetchBlobArrayBuffer).toHaveBeenLastCalledWith('blob-raw', 'message.eml', 'message/rfc822');
  });

  it('leaves arbitrary blob reads to the privileged tier', async () => {
    await expect(call(ARCHIVER, 'jmap.fetchBlob', 'blob-raw')).rejects.toThrow(/requires the privileged plugin tier/);
  });
});
