import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall, PERM_PER_METHOD } from '../plugin-sandbox/host-api';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { snapshotHostFeatures } from '../plugin-sandbox/host-features';
import { withAssistantRuntime } from '../plugin-sandbox/assistant/runtime';

function plugin(perms: string[], id = 'ai-assistant'): InstalledPlugin {
  return {
    id, name: 'AI Assistant', version: '2.2.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const ASSISTANT = plugin(['email:read', 'email:blob-read']);
const call = (p: InstalledPlugin, ...args: unknown[]) => dispatchApiCall(p, 'email.getAttachmentText', args);

const notes = { partId: '2', blobId: 'blob-notes', name: 'workshop-notes.txt', type: 'text/plain', size: 40 };
const minutes = { partId: '3', blobId: 'blob-docx', name: 'minutes.docx', type: 'application/octet-stream', size: 300 };
const photo = { partId: '4', blobId: 'blob-jpg', name: 'photo.jpg', type: 'image/jpeg', size: 3 };
const old = { partId: '5', blobId: 'blob-doc', name: 'old.doc', type: 'application/msword', size: 8 };
const huge = { partId: '6', blobId: 'blob-big', name: 'scan.pdf', type: 'application/pdf', size: 20 * 1024 * 1024 + 1 };

const message = {
  id: 'm1', threadId: 't1', blobId: 'blob-raw', size: 4, mailboxIds: { inbox: true }, keywords: {},
  subject: 'Workshop', receivedAt: '2026-05-01T10:00:00Z', attachments: [notes, minutes, photo, old, huge],
} as unknown as Email;

const DOCX = zipSync({
  'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Launch moves to 12 December.</w:t></w:r></w:p></w:body></w:document>'),
});
const BLOBS: Record<string, Uint8Array> = {
  'blob-notes': strToU8('Workshop notes\n\n1. Launch date moves to 12 December.\n'),
  'blob-docx': DOCX,
  'blob-jpg': new Uint8Array([0xff, 0xd8, 0xff]),
  'blob-doc': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
};

let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  resetPluginRateLimits();
  client = {
    // Every account has an m1: only the host's routing keeps a plugin out of the ones it may not read.
    getEmail: vi.fn(async (id: string) => (id === 'm1' ? message : null)),
    fetchBlobArrayBuffer: vi.fn(async (blobId: string) => {
      const bytes = BLOBS[blobId];
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }),
    getAccountId: vi.fn(() => 'acc1'),
    getMailboxes: vi.fn(async () => []),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useEmailStore.setState({ selectedEmail: null, emails: [], mailboxes: [], selectedMailbox: '' });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.email.getAttachmentText', () => {
  it('is behind email:blob-read, offered in the runtime and announced in the host features', async () => {
    expect(PERM_PER_METHOD['email.getAttachmentText']).toBe('email:blob-read');
    await expect(call(plugin(['email:read']), 'm1', 'blob-notes')).rejects.toThrow(/lacks permission "email:blob-read"/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(snapshotHostFeatures()).toMatchObject({ attachmentText: true });
    const calls: unknown[][] = [];
    const api = withAssistantRuntime({} as { email?: { getAttachmentText?: (...a: unknown[]) => unknown } }, async (method, args) => { calls.push([method, args]); return null; });
    await api.email?.getAttachmentText?.('m1', 'blob-notes', { maxChars: 10 });
    expect(calls).toEqual([['email.getAttachmentText', ['m1', 'blob-notes', { maxChars: 10 }]]]);
  });

  it('returns the text of a text attachment', async () => {
    const out = await call(ASSISTANT, 'm1', 'blob-notes');
    expect(out).toEqual({
      name: 'workshop-notes.txt', type: 'text/plain', size: BLOBS['blob-notes'].byteLength,
      format: 'text', status: 'ok', text: 'Workshop notes\n\n1. Launch date moves to 12 December.', truncated: false,
    });
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-notes', 'workshop-notes.txt', 'text/plain');
  });

  it('reads an Office file by its name and cuts at maxChars', async () => {
    expect(await call(ASSISTANT, 'm1', 'blob-docx')).toMatchObject({ format: 'docx', status: 'ok', text: 'Launch moves to 12 December.' });
    expect(await call(ASSISTANT, 'm1', 'blob-docx', { maxChars: 12 })).toMatchObject({ text: 'Launch moves', truncated: true });
  });

  it('answers with a status for what it can not read', async () => {
    expect(await call(ASSISTANT, 'm1', 'blob-jpg')).toMatchObject({ status: 'unsupported', text: '' });
    expect(await call(ASSISTANT, 'm1', 'blob-doc')).toMatchObject({ status: 'unsupported', format: 'other' });
  });

  it('answers too_big for an attachment over 20 MB without downloading it', async () => {
    expect(await call(ASSISTANT, 'm1', 'blob-big')).toMatchObject({ name: 'scan.pdf', format: 'pdf', status: 'too_big', text: '', truncated: false });
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a blob that is not an attachment of that message, and a message it can not find', async () => {
    await expect(call(ASSISTANT, 'm1', 'blob-raw')).rejects.toThrow(/not an attachment of this message/);
    await expect(call(ASSISTANT, 'm1', 'someone-elses-blob')).rejects.toThrow(/not an attachment/);
    await expect(call(ASSISTANT, 'missing', 'blob-notes')).rejects.toThrow(/no message with id "missing"/);
    // An account this login doesn't show is not asked.
    await expect(call(ASSISTANT, 'm1', 'blob-notes', { accountId: 'stranger' })).rejects.toThrow(/no message with id/);
    expect(client.getEmail).not.toHaveBeenCalledWith('m1', 'stranger');
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('reads an attachment of a shared folder from that account', async () => {
    useEmailStore.setState({ mailboxes: [{ id: 'shared-acc:inbox', originalId: 'inbox', name: 'Team', isShared: true, accountId: 'shared-acc' } as never] });
    expect(await call(ASSISTANT, 'm1', 'blob-notes', { accountId: 'shared-acc' })).toMatchObject({ status: 'ok' });
    expect(client.getEmail).toHaveBeenCalledWith('m1', 'shared-acc');
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-notes', 'workshop-notes.txt', 'text/plain', 'shared-acc');
  });

  it('checks its options', async () => {
    await expect(call(ASSISTANT, 'm1', 'blob-notes', { maxChars: 100_001 })).rejects.toThrow(/maxChars must be a whole number from 1 to 100000/);
    await expect(call(ASSISTANT, 'm1', 'blob-notes', { pages: 3 })).rejects.toThrow(/unknown property "pages"/);
    await expect(call(ASSISTANT, 'm1', 7)).rejects.toThrow(/blobId must be a string/);
  });

  it('allows 30 reads a minute per plugin', async () => {
    for (let i = 0; i < 30; i++) await call(ASSISTANT, 'm1', 'blob-notes');
    await expect(call(ASSISTANT, 'm1', 'blob-notes')).rejects.toThrow(/too many reads/);
    // Another plugin has its own count.
    await expect(call(plugin(['email:blob-read'], 'other'), 'm1', 'blob-notes')).resolves.toMatchObject({ status: 'ok' });
  });
});
