// Host side of api.composer: read and change the message being written, and
// attach files to it. The composer id comes from the composer itself (an
// action's click context or a composer slot's props; see
// composer-registry.ts).
//
//   composer.getBody(id)                        compose:read
//   composer.getSnapshot(id)                    compose:read
//   composer.readAttachment(id, attachmentId)   email:blob-read
//   composer.getSelection(id)                   compose:read
//   composer.replaceSelection(id, content, opts) compose:write
//   composer.replaceBody(id, content, opts)     compose:write
//   composer.attach(id, file)                   email:blob-write
//
// `content` is { text } or { html }. HTML goes through the same sanitiser as
// compose.open bodies. Edits are single editor transactions (one Ctrl+Z) and
// leave the signature, the quote and inline images in place.

import type { ComposerAttachmentData, ComposerSnapshot, InstalledPlugin } from '../plugin-types';
import { sanitizePluginBodyHtml } from '../email-sanitization';
import { htmlToPlainText } from '../html-to-text';
import { captureComposer, composerHandle, type ComposerHandle } from './composer-registry';
import { textToEditorHtml } from './composer-edit';
import { MAX_PLUGIN_FETCH_BYTES, readBoolean, readId, readObject, readString, withinRate } from './host-api-input';

const MAX_CONTENT = 512 * 1024;
const EDITS_PER_MINUTE = 60;

function handleFor(method: string, id: unknown): ComposerHandle {
  const handle = composerHandle(readId(id, method, 'composerId'));
  if (!handle) throw new Error(`${method}: that composer is not open any more`);
  return handle;
}

function readContent(method: string, value: unknown): { html: string; text: string } {
  const data = readObject(value, method, 'content', ['text', 'html']);
  if ((data.text === undefined) === (data.html === undefined)) throw new Error(`${method}: content needs either text or html`);
  if (data.html !== undefined) {
    const html = sanitizePluginBodyHtml(readString(data.html, method, 'content.html', MAX_CONTENT));
    return { html, text: htmlToPlainText(html) };
  }
  const text = readString(data.text, method, 'content.text', MAX_CONTENT);
  return { html: textToEditorHtml(text), text };
}

function rateLimited(method: string, plugin: InstalledPlugin): void {
  if (!withinRate('composer-edit', plugin.id, EDITS_PER_MINUTE)) {
    throw new Error(`${method}: at most ${EDITS_PER_MINUTE} edits a minute`);
  }
}

export function doComposerGetBody(_plugin: InstalledPlugin, id: unknown): { html: string; text: string } {
  return handleFor('composer.getBody', id).readBody();
}

export function doComposerGetSelection(_plugin: InstalledPlugin, id: unknown): { html: string; text: string; empty: boolean } {
  return handleFor('composer.getSelection', id).readSelection();
}

export function doComposerReplaceSelection(plugin: InstalledPlugin, id: unknown, content: unknown, opts: unknown): boolean {
  const method = 'composer.replaceSelection';
  const handle = handleFor(method, id);
  const { html, text } = readContent(method, content);
  const o = readObject(opts, method, 'options', ['below'], true);
  const below = o.below === undefined ? false : readBoolean(o.below, method, 'options.below');
  rateLimited(method, plugin);
  return handle.replaceSelection(html, text, { below });
}

/** Optionally reject a stale revision before the synchronous editor transaction.
 * 선택적으로 오래된 리비전을 거부한 뒤 동기 편집 트랜잭션을 실행합니다. */
export function doComposerReplaceBody(plugin: InstalledPlugin, id: unknown, content: unknown, options?: unknown): boolean {
  const method = 'composer.replaceBody';
  const handle = handleFor(method, id);
  const { html, text } = readContent(method, content);
  const opts = readObject(options, method, 'options', ['expectedRevision'], true);
  if (opts.expectedRevision !== undefined) {
    const expected = readId(opts.expectedRevision, method, 'options.expectedRevision');
    if (captureComposer(readId(id, method, 'composerId')).revision !== expected) throw new Error('composer_changed');
  }
  rateLimited(method, plugin);
  return handle.replaceBody(html, text);
}

/** Read a coherent draft snapshot without granting permission to send it.
 * 발송 권한 없이 일관된 작성창 스냅샷을 읽습니다. */
export function doComposerGetSnapshot(_plugin: InstalledPlugin, id: unknown): ComposerSnapshot {
  const composerId = readId(id, 'composer.getSnapshot', 'composerId');
  handleFor('composer.getSnapshot', composerId);
  return captureComposer(composerId);
}

/** Bound bytes and membership before and after reading a composer's attachment.
 * 작성창 첨부를 읽기 전후에 바이트 크기와 소속을 확인합니다. */
export async function doComposerReadAttachment(_plugin: InstalledPlugin, id: unknown, attachmentId: unknown): Promise<ComposerAttachmentData> {
  const method = 'composer.readAttachment';
  const composerId = readId(id, method, 'composerId');
  const fileId = readId(attachmentId, method, 'attachmentId');
  const handle = handleFor(method, composerId);
  const snapshot = captureComposer(composerId);
  const file = snapshot.attachments.find(item => item.id === fileId);
  if (!file || !handle.readAttachment) throw new Error('attachment_not_in_composer');
  if (file.size > MAX_PLUGIN_FETCH_BYTES) throw new Error(`${method}: attachment exceeds 25 MiB`);
  const result = await handle.readAttachment(fileId);
  if (composerHandle(composerId) !== handle || captureComposer(composerId).revision !== snapshot.revision) throw new Error('composer_changed');
  if (result.data.byteLength > MAX_PLUGIN_FETCH_BYTES) throw new Error(`${method}: attachment exceeds 25 MiB`);
  return { name: file.name, type: file.type, size: result.data.byteLength, data: result.data };
}

export async function doComposerAttach(plugin: InstalledPlugin, id: unknown, file: unknown): Promise<boolean> {
  const method = 'composer.attach';
  const handle = handleFor(method, id);
  const data = readObject(file, method, 'file', ['blobId', 'name', 'type', 'size']);
  const blobId = readId(data.blobId, method, 'file.blobId');
  const name = readString(data.name, method, 'file.name', 255, { min: 1 });
  const type = data.type === undefined ? 'application/octet-stream' : readString(data.type, method, 'file.type', 255, { min: 1 });
  if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0) {
    throw new Error(`${method}: file.size must be a whole number of bytes`);
  }
  rateLimited(method, plugin);
  return handle.attach({ blobId, name, type, size: data.size });
}
