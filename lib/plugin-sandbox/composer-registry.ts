// Open composers that plugins may work on (api.composer.*).
//
// Each composer registers a handle under a random id while it is open. A
// plugin learns the id only from the composer itself: the click context of
// a composer action (Attach menu, toolbar, Options, Send menu) or the props
// of a composer slot. So a plugin edits the message the user pointed it
// at, never one it found by itself.

import { generateUUID } from '@/lib/utils';
import type { ComposerSnapshot, ComposerAttachmentData } from '@/lib/plugin-types';

export interface ComposerContent {
  html: string;
  text: string;
}

export interface ComposerAttachment {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export type ComposerMetadata = {
  subject: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  pending?: boolean;
  attachments: ComposerSnapshot['attachments'];
  accountKey?: string;
  identityId?: string;
};

export interface ComposerHandle {
  /** Read this composer's metadata; account and identity stay host-side.
   * 이 작성창의 메타데이터만 읽으며 계정과 identity는 호스트에 남습니다. */
  readMetadata?(): ComposerMetadata;
  /** Read a file currently attached to this composer. 현재 첨부된 파일만 읽습니다. */
  readAttachment?(id: string): Promise<ComposerAttachmentData>;
  /** The user's own text, without the signature and the quote. */
  readBody(): ComposerContent;
  readSelection(): ComposerContent & { empty: boolean };
  /** Replace the user's own text. */
  replaceBody(html: string, text: string): boolean;
  /** Replace the selection (or insert at the caret), or with `below` add after it. */
  replaceSelection(html: string, text: string, opts: { below: boolean }): boolean;
  /** Attach a blob the plugin uploaded, through the composer's usual checks. */
  attach(file: ComposerAttachment): Promise<boolean>;
}

const handles = new Map<string, ComposerHandle>();
const snapshots = new Map<string, { fingerprint: string; revision: string }>();

/** Bind an opaque revision to the current body, recipients, files and account.
 * 현재 본문·수신인·첨부·계정에 불투명 리비전을 결합합니다. */
export function captureComposer(id: string): ComposerSnapshot {
  const handle = handles.get(id);
  if (!handle) throw new Error('composer is not open any more');
  const body = handle.readBody();
  const metadata = handle.readMetadata?.() ?? { subject: '', to: [], attachments: [] };
  const fingerprint = JSON.stringify({ body, metadata });
  let current = snapshots.get(id);
  if (!current || current.fingerprint !== fingerprint) {
    current = { fingerprint, revision: generateUUID() };
    snapshots.set(id, current);
  }
  return {
    revision: current.revision,
    subject: metadata.subject,
    text: body.text,
    to: [...metadata.to],
    cc: [...(metadata.cc ?? [])],
    bcc: [...(metadata.bcc ?? [])],
    attachments: metadata.attachments.map(file => ({ ...file })),
    pending: metadata.pending ?? false,
  };
}

/** Register an open composer, optionally using a preallocated capability id.
 * 미리 할당한 ID를 선택적으로 사용하여 열린 작성창을 등록합니다. */
export function registerComposer(handle: ComposerHandle, id = generateUUID()): { id: string; unregister: () => void } {
  handles.set(id, handle);
  return { id, unregister: () => { handles.delete(id); snapshots.delete(id); } };
}

export function composerHandle(id: unknown): ComposerHandle | null {
  return typeof id === 'string' ? handles.get(id) ?? null : null;
}

/** Test helper. */
export function resetComposers(): void {
  handles.clear();
  snapshots.clear();
}
