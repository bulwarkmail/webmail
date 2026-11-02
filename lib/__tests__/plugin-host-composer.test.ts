import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { HIGH_RISK_PERMISSIONS } from '../plugin-sandbox/permission-text';
import { registerComposer, resetComposers, type ComposerHandle } from '../plugin-sandbox/composer-registry';
import { plainOwnRange, replaceTextareaRange } from '../plugin-sandbox/composer-edit';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const { dispatchApiCall } = await import('../plugin-sandbox/host-api');

// api.composer on the host: which permission each call needs, what it
// accepts, and that a plugin reaches only a composer whose id it was given.

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'text-tools', name: 'Text tools', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

function fakeHandle(): ComposerHandle & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    readBody: () => ({ html: '<p>Hello</p>', text: 'Hello' }),
    readSelection: () => ({ html: '', text: '', empty: true }),
    replaceBody: (...a) => { calls.push(['replaceBody', ...a]); return true; },
    replaceSelection: (...a) => { calls.push(['replaceSelection', ...a]); return true; },
    attach: async (...a) => { calls.push(['attach', ...a]); return true; },
  };
}

const READ = plugin(['compose:read']);
const WRITE = plugin(['compose:write']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

beforeEach(() => resetPluginRateLimits());
afterEach(() => resetComposers());

describe('api.composer', () => {
  it('reads a stable snapshot with compose:read, without send permission or plugin configuration', async () => {
    const handle = fakeHandle();
    handle.readMetadata = () => ({ subject: 'Subject', to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], attachments: [], pending: false });
    const { id } = registerComposer(handle);
    const snapshot = await call(READ, 'composer.getSnapshot', id) as { revision: string };
    expect(snapshot).toMatchObject({ text: 'Hello', subject: 'Subject', to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], attachments: [], pending: false });
    expect(await call(READ, 'composer.getSnapshot', id)).toEqual(snapshot);
    await expect(call(WRITE, 'composer.getSnapshot', id)).rejects.toThrow(/lacks permission "compose:read"/);
    await expect(call(plugin(['email:send']), 'composer.getSnapshot', id)).rejects.toThrow(/lacks permission "compose:read"/);
  });

  it('rejects an obsolete body revision and accepts the current snapshot', async () => {
    const handle = fakeHandle();
    let text = 'First draft';
    handle.readBody = () => ({ text, html: `<p>${text}</p>` });
    const { id } = registerComposer(handle);
    const original = await call(READ, 'composer.getSnapshot', id) as { revision: string };
    text = 'Edited draft';
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'Replacement' }, { expectedRevision: original.revision })).rejects.toThrow('composer_changed');
    expect(handle.calls).toEqual([]);
    const current = await call(READ, 'composer.getSnapshot', id) as { revision: string };
    expect(current.revision).not.toBe(original.revision);
    expect(await call(WRITE, 'composer.replaceBody', id, { text: 'Replacement' }, { expectedRevision: current.revision })).toBe(true);
  });

  it.each(['subject', 'to', 'cc', 'bcc', 'attachments', 'accountKey', 'identityId', 'pending'] as const)('invalidates the snapshot when %s changes', async (field) => {
    const handle = fakeHandle();
    let metadata = { subject: 'Subject', to: ['to@example.com'], cc: [] as string[], bcc: [] as string[], attachments: [] as { id: string; name: string; type: string; size: number }[], accountKey: 'account-one', identityId: 'identity-one', pending: false };
    handle.readMetadata = () => metadata;
    const { id } = registerComposer(handle);
    const original = await call(READ, 'composer.getSnapshot', id) as { revision: string };
    const changes = { subject: 'New subject', to: ['other@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], attachments: [{ id: 'file', name: 'file.txt', type: 'text/plain', size: 1 }], accountKey: 'account-two', identityId: 'identity-two', pending: true };
    metadata = { ...metadata, [field]: changes[field] };
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'Replacement' }, { expectedRevision: original.revision })).rejects.toThrow('composer_changed');
    expect(handle.calls).toEqual([]);
  });

  it('limits attachment reads to the selected composer and the blob-read permission', async () => {
    const handle = fakeHandle();
    handle.readMetadata = () => ({ subject: '', to: [], attachments: [{ id: 'attached', name: 'file.bin', type: 'application/octet-stream', size: 3 }] });
    handle.readAttachment = vi.fn(async () => ({ name: 'file.bin', type: 'application/octet-stream', size: 3, data: new Uint8Array([1, 2, 3]).buffer }));
    const { id } = registerComposer(handle);
    const reader = plugin(['email:blob-read']);
    await expect(call(READ, 'composer.readAttachment', id, 'attached')).rejects.toThrow(/lacks permission "email:blob-read"/);
    await expect(call(reader, 'composer.readAttachment', id, 'unattached')).rejects.toThrow('attachment_not_in_composer');
    expect(handle.readAttachment).not.toHaveBeenCalled();
    expect(await call(reader, 'composer.readAttachment', id, 'attached')).toMatchObject({ name: 'file.bin', size: 3 });
    expect(handle.readAttachment).toHaveBeenCalledTimes(1);
  });

  it('rejects an attachment read if the account changes while awaiting its bytes', async () => {
    const handle = fakeHandle();
    let accountKey = 'account-one';
    handle.readMetadata = () => ({ subject: '', to: [], accountKey, attachments: [{ id: 'attached', name: 'file.bin', type: 'application/octet-stream', size: 1 }] });
    handle.readAttachment = async () => { accountKey = 'account-two'; return { name: 'file.bin', type: 'application/octet-stream', size: 1, data: new ArrayBuffer(1) }; };
    const { id } = registerComposer(handle);
    await expect(call(plugin(['email:blob-read']), 'composer.readAttachment', id, 'attached')).rejects.toThrow('composer_changed');
  });

  it('discards attachment bytes if their composer closed during the read', async () => {
    const handle = fakeHandle();
    handle.readMetadata = () => ({ subject: '', to: [], attachments: [{ id: 'attached', name: 'file.txt', type: 'text/plain', size: 1 }] });
    const { id, unregister } = registerComposer(handle);
    handle.readAttachment = async () => { unregister(); return { name: 'file.txt', type: 'text/plain', size: 1, data: new ArrayBuffer(1) }; };
    await expect(call(plugin(['email:blob-read']), 'composer.readAttachment', id, 'attached')).rejects.toThrow('composer_changed');
  });

  it('rejects oversized attachment metadata before fetching and oversized actual bytes afterward', async () => {
    const handle = fakeHandle();
    let size = 25 * 1024 * 1024 + 1;
    handle.readMetadata = () => ({ subject: '', to: [], attachments: [{ id: 'attached', name: 'file.bin', type: 'application/octet-stream', size }] });
    handle.readAttachment = vi.fn(async () => ({ name: 'file.bin', type: 'application/octet-stream', size: 1, data: new ArrayBuffer(25 * 1024 * 1024 + 1) }));
    const { id } = registerComposer(handle);
    const reader = plugin(['email:blob-read']);
    await expect(call(reader, 'composer.readAttachment', id, 'attached')).rejects.toThrow('25 MiB');
    expect(handle.readAttachment).not.toHaveBeenCalled();
    size = 1;
    await expect(call(reader, 'composer.readAttachment', id, 'attached')).rejects.toThrow('25 MiB');
    expect(handle.readAttachment).toHaveBeenCalledTimes(1);
  });

  it('reads the open message with compose:read only', async () => {
    const { id } = registerComposer(fakeHandle());
    expect(await call(READ, 'composer.getBody', id)).toEqual({ html: '<p>Hello</p>', text: 'Hello' });
    await expect(call(WRITE, 'composer.getBody', id)).rejects.toThrow(/lacks permission "compose:read"/);
  });

  it('changes it with compose:write only', async () => {
    const handle = fakeHandle();
    const { id } = registerComposer(handle);
    await expect(call(READ, 'composer.replaceBody', id, { text: 'x' })).rejects.toThrow(/lacks permission "compose:write"/);
    await expect(call(READ, 'composer.replaceSelection', id, { text: 'x' })).rejects.toThrow(/lacks permission "compose:write"/);
    expect(handle.calls).toEqual([]);
    expect(await call(WRITE, 'composer.replaceSelection', id, { text: 'Dear Bob,\nthanks' }, { below: true })).toBe(true);
    expect(handle.calls[0]).toEqual(['replaceSelection', '<p>Dear Bob,</p><p>thanks</p>', 'Dear Bob,\nthanks', { below: true }]);
  });

  it('turns plain text into escaped paragraphs and runs HTML through the sanitiser', async () => {
    const handle = fakeHandle();
    const { id } = registerComposer(handle);
    await call(WRITE, 'composer.replaceBody', id, { text: '<b>not bold</b>' });
    await call(WRITE, 'composer.replaceBody', id, { html: '<p onclick="x()">Hi<script>alert(1)</script></p>' });
    expect(handle.calls[0][1]).toBe('<p>&lt;b&gt;not bold&lt;/b&gt;</p>');
    expect(handle.calls[1][1]).not.toMatch(/onclick|script/);
    expect(handle.calls[1][1]).toContain('Hi');
  });

  it('keeps lists, quotes and headings a plugin sends as HTML', async () => {
    const handle = fakeHandle();
    const { id } = registerComposer(handle);
    await call(WRITE, 'composer.replaceSelection', id, { html: '<h3>Files</h3><ul><li><a href="https://cloud.example.org/s/1">a.pdf</a></li></ul><blockquote>q</blockquote>' });
    const html = handle.calls[0][1] as string;
    expect(html).toContain('<ul><li><a href="https://cloud.example.org/s/1">a.pdf</a></li></ul>');
    expect(html).toContain('<h3>Files</h3>');
    expect(html).toContain('<blockquote>q</blockquote>');
  });

  it('reaches only a composer that is open, by the id it handed out', async () => {
    const { unregister } = registerComposer(fakeHandle());
    await expect(call(READ, 'composer.getBody', 'guess')).rejects.toThrow(/not open any more/);
    await expect(call(READ, 'composer.getBody')).rejects.toThrow(/composerId must be a string/);
    const second = registerComposer(fakeHandle());
    second.unregister();
    await expect(call(READ, 'composer.getBody', second.id)).rejects.toThrow(/not open any more/);
    unregister();
  });

  it('refuses content that is neither or both of text and html, and odd options', async () => {
    const { id } = registerComposer(fakeHandle());
    await expect(call(WRITE, 'composer.replaceBody', id, {})).rejects.toThrow(/either text or html/);
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'a', html: '<p>a</p>' })).rejects.toThrow(/either text or html/);
    await expect(call(WRITE, 'composer.replaceBody', id, { markdown: '*a*' })).rejects.toThrow(/unknown property "markdown"/);
    await expect(call(WRITE, 'composer.replaceSelection', id, { text: 'a' }, { at: 'end' })).rejects.toThrow(/unknown property "at"/);
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'a' }, { revision: 'unknown' })).rejects.toThrow(/unknown property "revision"/);
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'a' }, { expectedRevision: '' })).rejects.toThrow(/expectedRevision/);
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'a' }, { expectedRevision: 1 })).rejects.toThrow(/expectedRevision/);
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'x'.repeat(512 * 1024 + 1) })).rejects.toThrow(/at most/);
  });

  it('attaches an uploaded blob with email:blob-write, checking the fields', async () => {
    const handle = fakeHandle();
    const { id } = registerComposer(handle);
    const attacher = plugin(['email:blob-write']);
    await expect(call(WRITE, 'composer.attach', id, { blobId: 'B1', name: 'a.pdf', size: 1 })).rejects.toThrow(/lacks permission "email:blob-write"/);
    expect(await call(attacher, 'composer.attach', id, { blobId: 'B1', name: 'a.pdf', size: 10 })).toBe(true);
    expect(handle.calls[0]).toEqual(['attach', { blobId: 'B1', name: 'a.pdf', type: 'application/octet-stream', size: 10 }]);
    await expect(call(attacher, 'composer.attach', id, { blobId: 'B1', name: 'a.pdf', size: -1 })).rejects.toThrow(/whole number/);
    await expect(call(attacher, 'composer.attach', id, { blobId: 'B1', name: '', size: 1 })).rejects.toThrow(/name/);
  });

  it('allows 60 edits a minute', async () => {
    const { id } = registerComposer(fakeHandle());
    for (let i = 0; i < 60; i++) await call(WRITE, 'composer.replaceBody', id, { text: `${i}` });
    await expect(call(WRITE, 'composer.replaceBody', id, { text: 'one more' })).rejects.toThrow(/at most 60 edits a minute/);
  });

  it('counts reading the draft as ordinary, not high-risk; the plugin still needs a composer id', () => {
    expect(HIGH_RISK_PERMISSIONS.has('compose:read')).toBe(false);
    expect(HIGH_RISK_PERMISSIONS.has('compose:write')).toBe(false);
  });
});

describe('plain-text composer', () => {
  it('finds the own text above the signature separator, the quote header and the quote', () => {
    const body = 'Hi Bob,\nsure.\n\n-- \nAlice\n\nOn Monday, Bob wrote:\n> Can you?';
    const { from, to } = plainOwnRange(body, { replyLike: true });
    expect(body.slice(from, to)).toBe('Hi Bob,\nsure.');
    const reply = 'Thanks!\n\nOn Monday, Bob wrote:\n> Can you?';
    expect(reply.slice(0, plainOwnRange(reply, { replyLike: true }).to)).toBe('Thanks!');
    const sig = 'Hello\n\nAlice Example\nACME';
    expect(sig.slice(0, plainOwnRange(sig, { signature: 'Alice Example\nACME' }).to)).toBe('Hello');
    const fwd = 'FYI\n\n---------- Forwarded message ----------\nFrom: Bob';
    expect(fwd.slice(0, plainOwnRange(fwd, { forwardedSeparator: '---------- Forwarded message ----------' }).to)).toBe('FYI');
  });

  it('edits the textarea through the browser\'s editing command, so its undo keeps working', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'Hello Bob,\n\n-- \nAlice';
    document.body.appendChild(textarea);
    const exec = vi.fn((_cmd: string, _ui: boolean, text: string) => {
      textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
      return true;
    });
    const doc = document as unknown as { execCommand: unknown };
    const original = doc.execCommand;
    doc.execCommand = exec;
    const input = vi.fn();
    textarea.addEventListener('input', input);
    try {
      replaceTextareaRange(textarea, 0, 10, 'Hi Bob,');
      expect(exec).toHaveBeenCalledWith('insertText', false, 'Hi Bob,');
      expect(textarea.value).toBe('Hi Bob,\n\n-- \nAlice');
    } finally {
      doc.execCommand = original;
      textarea.remove();
    }
  });

  it('falls back to setRangeText and an input event where the command is missing', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'Hello';
    document.body.appendChild(textarea);
    const input = vi.fn();
    textarea.addEventListener('input', input);
    const doc = document as unknown as { execCommand: unknown };
    const original = doc.execCommand;
    doc.execCommand = () => false;
    try {
      replaceTextareaRange(textarea, 0, 5, 'Hi');
      expect(textarea.value).toBe('Hi');
      expect(input).toHaveBeenCalledTimes(1);
    } finally {
      doc.execCommand = original;
      textarea.remove();
    }
  });
});
