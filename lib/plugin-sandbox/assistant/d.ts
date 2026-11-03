// Area d of the assistant's host APIs, host side (see README.md): the
// user's Files. Find, list and read files (own drive and drives others
// shared), attach them to a draft, save attachments into Files, create text
// and Markdown files and folders, replace a text file (the old version goes
// into the Files trash), move and rename.
//
// Over the JMAP client and the Files helpers, never the Files store's
// actions: those re-list the open Files view and replace its Undo. The
// plugin hooks the store fires fire here too (onBeforeFileUpload,
// onBeforeFileMove, onBeforeFileRename and the observers), so another
// plugin can still stop a change. Writes go only into the user's own
// drive and never into a folder that is shared (shareWith on it or above
// it). Nothing here deletes, shares, makes a public link or moves a file to
// another account: those calls don't exist.

import type { InstalledPlugin, Permission } from '../../plugin-types';
import type { IJMAPClient } from '../../jmap/client-interface';
import type { FileNode } from '../../jmap/types';
import { NOT_MINE } from './not-mine';
import type { AttachmentImageView, AttachmentTextView } from './b.types';
import type {
  AreaHostFeaturesD, FileAttachResult, FileCreateResult, FileFindQuery, FileInfo,
} from './d.types';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useFileStore } from '@/stores/file-store';
import { fileNodeKind } from '@/lib/jmap/filenode-kind';
import { TRASH_FOLDER_NAME, findTrashFolder, trashBatchName, trashSubtreeIds } from '@/lib/files-trash';
import { fileNameProblem, type FileNameProblem } from '@/lib/file-name-rules';
import { invalidateFileSearchCache, pathOfNode } from '@/lib/global-search/providers/files';
import { saveBlobsToFiles } from '@/lib/files-save';
import { emailHooks, fileHooks } from '@/lib/plugin-hooks';
import { fileToView } from '@/lib/plugin-projection';
import { pluginHasPermission } from '../permissions';
import { readNamedEmail } from '../host-api-mail';
import { doComposeOpen } from '../host-api-compose';
import { composerHandle } from '../composer-registry';
import {
  isPlainRecord, readBoolean, readId, readInteger, readObject, readString, sessionClient, withinRate,
} from '../host-api-input';
// The readers (pdf.js, the Office reader) load only when a file is read.
import { DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS, MAX_TEXT_SOURCE_BYTES } from '@/lib/attachment-text/types';
import { DEFAULT_IMAGE_SIDE, MAX_IMAGE_SIDE, MIN_IMAGE_SIDE, shrinkImage, toBase64 } from '@/lib/image-shrink';
import { readPhotoExif } from '@/lib/exif';

/** Method → permission, joined into PERM_PER_METHOD. Some also need a second one, checked in the method. */
export const PERMS: Readonly<Record<string, Permission | null>> = {
  'files.find': 'files:read',
  'files.list': 'files:read',
  'files.getText': 'files:read',
  'files.getImage': 'files:read',
  // And compose:write (an open draft) or compose:open (a new one).
  'files.attach': 'files:read',
  // And email:read.
  'files.saveAttachments': 'files:write',
  'files.create': 'files:write',
  'files.createFolder': 'files:write',
  'files.move': 'files:write',
  'files.rename': 'files:write',
};

/** How long a listing of the user's files serves files.find and files.list. */
export const FILE_LISTING_TTL_MS = 60_000;
/** Reads of a file's text or picture a plugin may make per minute. */
export const MAX_FILE_READS_PER_MINUTE = 30;
/** Changes to Files (create, save, move, rename) a plugin may make per minute. */
export const MAX_FILE_WRITES_PER_MINUTE = 20;
/** Most results of files.find, and its default. */
export const MAX_FIND_RESULTS = 50;
const DEFAULT_FIND_RESULTS = 20;
/** Most entries files.list returns. */
export const MAX_LIST_ENTRIES = 200;
/** Most files one files.attach or files.saveAttachments call takes. */
export const MAX_FILES_AT_ONCE = 20;
/** Longest text files.create writes, in characters. */
export const MAX_CREATE_CHARS = 512 * 1024;

const TEXT_TYPES = ['text/markdown', 'text/plain'] as const;

// ─── Availability and the listing ───

/** Files as the app offers it: the server has it for this account and the administrator left it on (as the navigation rail decides). */
export function filesAvailable(): boolean {
  const client = useAuthStore.getState().client;
  return !!client?.supportsFiles?.() && usePolicyStore.getState().isFeatureEnabled('filesEnabled');
}

let listing: { client: IJMAPClient; at: number; promise: Promise<FileNode[]> } | null = null;
let watchingStore = false;

/** Forget the cached listing (after a change, or in tests). */
export function forgetFileListing(): void {
  listing = null;
}

/** Every node of the user's own drive and of the drives shared with them, cached for a minute. */
function allNodes(client: IJMAPClient): Promise<FileNode[]> {
  if (!watchingStore) {
    watchingStore = true;
    // A change in the Files view makes the cached listing stale.
    useFileStore.subscribe((state, previous) => {
      if (state.lastAction !== previous.lastAction || (previous.isLoading && !state.isLoading)) forgetFileListing();
    });
  }
  const now = Date.now();
  if (listing && listing.client === client && now - listing.at < FILE_LISTING_TTL_MS) return listing.promise;
  const entry = { client, at: now, promise: client.listAllFileNodesAcrossAccounts() };
  listing = entry;
  entry.promise.catch(() => { if (listing === entry) listing = null; });
  return entry.promise;
}

/**
 * What the assistant may see: everything but the Files trash and what is
 * in it, 1.0's symlinks (they hold nothing) and the folders of another
 * account that are listed only as the way down to something shared.
 */
function visibleNodes(nodes: FileNode[]): FileNode[] {
  const trashed = trashSubtreeIds(nodes, findTrashFolder(nodes)?.id);
  return nodes.filter((n) => !n.discoverableOnly && !trashed.has(n.id) && fileNodeKind(n) !== 'symlink');
}

const isFolder = (node: FileNode) => fileNodeKind(node) === 'directory';

function infoOf(node: FileNode, nodes: FileNode[]): FileInfo {
  const folder = isFolder(node);
  return {
    id: node.id,
    name: node.name,
    path: pathOfNode(nodes, node),
    parentId: node.parentId ?? null,
    kind: folder ? 'folder' : 'file',
    mimeType: folder ? '' : (node.type || 'application/octet-stream'),
    size: folder ? 0 : (node.size || 0),
    modified: node.modified || node.created || '',
    ...(node.isShared ? { shared: true, ...(node.accountName ? { owner: node.accountName } : {}) } : {}),
  };
}

function findNode(method: string, nodes: FileNode[], id: string): FileNode {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`${method}: no file or folder with id "${id}"`);
  return node;
}

function needFiles(method: string): IJMAPClient {
  const client = sessionClient(method);
  if (!filesAvailable()) throw new Error(`${method}: Files is not available`);
  return client;
}

function needPermission(plugin: InstalledPlugin, method: string, permission: Permission): void {
  if (!pluginHasPermission(plugin, permission)) throw new Error(`Plugin "${plugin.id}" lacks permission "${permission}"`);
}

/** Counts a change to Files against the plugin's limit, refusing past it. */
function countWrite(method: string, plugin: InstalledPlugin): void {
  if (!withinRate('files-write', plugin.id, MAX_FILE_WRITES_PER_MINUTE)) {
    throw new Error(`${method}: at most ${MAX_FILE_WRITES_PER_MINUTE} changes to Files a minute`);
  }
}

// ─── Kinds of files ───

const EXT = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
const KIND_EXTENSIONS: Record<string, string[]> = {
  pdf: ['pdf'],
  spreadsheet: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv', 'numbers'],
  presentation: ['pptx', 'pptm', 'ppt', 'odp', 'key'],
  text: ['txt', 'md', 'markdown', 'log', 'rtf'],
  word: ['docx', 'docm', 'doc', 'odt', 'pages'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'svg'],
};

function matchesKind(node: FileNode, kind: NonNullable<FileFindQuery['kind']>): boolean {
  if (kind === 'folder') return isFolder(node);
  if (isFolder(node)) return false;
  const ext = EXT(node.name);
  const type = (node.type || '').toLowerCase();
  const is = (k: string) => KIND_EXTENSIONS[k].includes(ext);
  switch (kind) {
    case 'image': return type.startsWith('image/') || is('image');
    case 'pdf': return type === 'application/pdf' || is('pdf');
    case 'spreadsheet': return is('spreadsheet') || /spreadsheet|excel|text\/csv/.test(type);
    case 'presentation': return is('presentation') || /presentation|powerpoint/.test(type);
    case 'text': return is('text') || type.startsWith('text/');
    case 'document':
      return ['pdf', 'spreadsheet', 'presentation', 'text', 'word'].some(is)
        || /pdf|wordprocessing|msword|opendocument|spreadsheet|presentation|^text\//.test(type);
  }
}

const KINDS = ['document', 'image', 'pdf', 'spreadsheet', 'presentation', 'text', 'folder'] as const;

function readDate(value: unknown, method: string, field: string): number {
  const text = readString(value, method, field, 40, { min: 1 });
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`${method}: ${field} must be a date like 2026-05-01 or 2026-05-01T10:00:00Z`);
  return at;
}

const modifiedAt = (node: FileNode) => Date.parse(node.modified || node.created || '') || 0;

// ─── Reading ───

/** Files and folders that match, newest first (see FileFindQuery). */
export async function doFilesFind(_plugin: InstalledPlugin, queryArg?: unknown): Promise<FileInfo[]> {
  const method = 'files.find';
  const query = readObject(queryArg, method, 'query', ['text', 'folderId', 'kind', 'modifiedAfter', 'modifiedBefore', 'limit'], true);
  const words = query.text === undefined ? [] : readString(query.text, method, 'text', 200).toLowerCase().split(/\s+/).filter(Boolean);
  const folderId = query.folderId === undefined ? null : readId(query.folderId, method, 'folderId');
  if (query.kind !== undefined && !(KINDS as readonly unknown[]).includes(query.kind)) {
    throw new Error(`${method}: kind must be one of ${KINDS.join(', ')}`);
  }
  const kind = query.kind as FileFindQuery['kind'];
  const after = query.modifiedAfter === undefined ? null : readDate(query.modifiedAfter, method, 'modifiedAfter');
  const before = query.modifiedBefore === undefined ? null : readDate(query.modifiedBefore, method, 'modifiedBefore');
  const limit = query.limit === undefined ? DEFAULT_FIND_RESULTS : readInteger(query.limit, method, 'limit', 1, MAX_FIND_RESULTS);
  const client = needFiles(method);
  const all = await allNodes(client);
  const nodes = visibleNodes(all);
  let below: Set<string> | null = null;
  if (folderId !== null) {
    const folder = findNode(method, nodes, folderId);
    if (!isFolder(folder)) throw new Error(`${method}: "${folder.name}" is not a folder`);
    below = new Set([folder.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of nodes) if (n.parentId && below.has(n.parentId) && !below.has(n.id)) { below.add(n.id); grew = true; }
    }
    below.delete(folder.id);
  }
  const hits = nodes.filter((node) => {
    if (below && !below.has(node.id)) return false;
    if (kind && !matchesKind(node, kind)) return false;
    if (after !== null && modifiedAt(node) < after) return false;
    if (before !== null && modifiedAt(node) >= before) return false;
    if (words.length) {
      const hay = `${node.name} ${pathOfNode(all, node)}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  hits.sort((a, b) => modifiedAt(b) - modifiedAt(a));
  return hits.slice(0, limit).map((n) => infoOf(n, all));
}

/** What a folder holds (folders first, then by name); without a folder, the top of the user's drive and what others shared with them. */
export async function doFilesList(_plugin: InstalledPlugin, folderArg?: unknown): Promise<FileInfo[]> {
  const method = 'files.list';
  const folderId = folderArg === undefined || folderArg === null ? null : readId(folderArg, method, 'folderId');
  const client = needFiles(method);
  const all = await allNodes(client);
  const nodes = visibleNodes(all);
  let entries: FileNode[];
  if (folderId === null) {
    const ids = new Set(nodes.map((n) => n.id));
    entries = nodes.filter((n) => (n.isShared
      // The top of what is shared: its parent isn't something the user can open.
      ? !n.parentId || !ids.has(n.parentId)
      : (n.parentId ?? null) === null));
  } else {
    const folder = findNode(method, nodes, folderId);
    if (!isFolder(folder)) throw new Error(`${method}: "${folder.name}" is not a folder`);
    entries = nodes.filter((n) => n.parentId === folder.id);
  }
  entries.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name));
  return entries.slice(0, MAX_LIST_ENTRIES).map((n) => infoOf(n, all));
}

async function readableFile(method: string, plugin: InstalledPlugin, fileArg: unknown): Promise<{ client: IJMAPClient; node: FileNode }> {
  const fileId = readId(fileArg, method, 'fileId');
  const client = needFiles(method);
  if (!withinRate(method, plugin.id, MAX_FILE_READS_PER_MINUTE)) throw new Error(`${method}: too many reads, try again in a minute`);
  const node = findNode(method, visibleNodes(await allNodes(client)), fileId);
  if (isFolder(node) || !node.blobId) throw new Error(`${method}: "${node.name}" is a folder`);
  return { client, node };
}

/**
 * A file's bytes, read no further than MAX_TEXT_SOURCE_BYTES + 1: the size
 * the listing gives may be wrong, so the download stops itself. Null when
 * the file is bigger than that.
 */
async function fetchNode(client: IJMAPClient, node: FileNode): Promise<ArrayBuffer | null> {
  const accountId = node.isShared && node.accountId ? node.accountId : undefined;
  const data = await client.fetchBlobArrayBuffer(node.blobId as string, node.name || undefined, node.type || undefined, accountId, MAX_TEXT_SOURCE_BYTES + 1);
  return data.byteLength > MAX_TEXT_SOURCE_BYTES ? null : data;
}

/** The text of a file, with the attachment reader (see AttachmentTextView). */
export async function doFilesGetText(plugin: InstalledPlugin, fileArg: unknown, optionsArg?: unknown): Promise<AttachmentTextView> {
  const method = 'files.getText';
  readId(fileArg, method, 'fileId');
  const opts = readObject(optionsArg, method, 'options', ['maxChars'], true);
  const maxChars = opts.maxChars === undefined ? DEFAULT_TEXT_CHARS : readInteger(opts.maxChars, method, 'maxChars', 1, MAX_TEXT_CHARS);
  const { client, node } = await readableFile(method, plugin, fileArg);
  const name = node.name || 'file';
  const type = node.type || 'application/octet-stream';
  const base = { name, type, size: node.size || 0 };
  const { extractText, textFormatOf } = await import('@/lib/attachment-text');
  if ((node.size || 0) > MAX_TEXT_SOURCE_BYTES) {
    return { ...base, format: textFormatOf(name, type), status: 'too_big', text: '', truncated: false };
  }
  const data = await fetchNode(client, node);
  if (!data) return { ...base, format: textFormatOf(name, type), status: 'too_big', text: '', truncated: false };
  const result = await extractText(data, { name, type, maxChars });
  return { ...base, size: data.byteLength, ...result };
}

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;

/** A picture the browser can draw; SVG is left out (it can load remote content). */
function isRasterImage(name: string, type: string): boolean {
  const mediaType = type.split(';')[0].trim().toLowerCase();
  if (mediaType === 'image/svg+xml' || /\.svgz?$/i.test(name)) return false;
  return mediaType.startsWith('image/') || IMAGE_NAME.test(name);
}

/** A picture file, shrunk in the app as api.email.getAttachmentImage does (see AttachmentImageView). */
export async function doFilesGetImage(plugin: InstalledPlugin, fileArg: unknown, optionsArg?: unknown): Promise<AttachmentImageView> {
  const method = 'files.getImage';
  readId(fileArg, method, 'fileId');
  const opts = readObject(optionsArg, method, 'options', ['maxSide', 'exif'], true);
  const maxSide = opts.maxSide === undefined ? DEFAULT_IMAGE_SIDE : readInteger(opts.maxSide, method, 'maxSide', MIN_IMAGE_SIDE, MAX_IMAGE_SIDE);
  const wantExif = opts.exif === undefined ? false : readBoolean(opts.exif, method, 'exif');
  const { client, node } = await readableFile(method, plugin, fileArg);
  const name = node.name || 'image';
  const sourceType = node.type || 'application/octet-stream';
  const answer = (status: AttachmentImageView['status'], width = 0, height = 0): AttachmentImageView => ({ name, type: sourceType, width, height, data: '', status });
  if (!isRasterImage(name, sourceType)) return answer('unsupported');
  if ((node.size || 0) > MAX_TEXT_SOURCE_BYTES) return answer('too_big');
  const data = await fetchNode(client, node);
  if (!data) return answer('too_big');
  const shrunk = await shrinkImage(new Blob([data], { type: sourceType }), { maxSide });
  if (shrunk.status !== 'ok' || !shrunk.bytes || !shrunk.type) return answer(shrunk.status === 'ok' ? 'failed' : shrunk.status, shrunk.width, shrunk.height);
  const exif = wantExif ? readPhotoExif(data) : null;
  return {
    name, type: shrunk.type, width: shrunk.width ?? 0, height: shrunk.height ?? 0, data: toBase64(shrunk.bytes), status: 'ok',
    ...(exif && Object.keys(exif).length ? { exif } : {}),
  };
}

// ─── Attaching ───

const SAFE_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const attachType = (type: string) => (SAFE_TYPE.test(type) ? type : 'application/octet-stream');

function readFileIds(method: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${method}: fileIds must be a list of file ids`);
  if (value.length > MAX_FILES_AT_ONCE) throw new Error(`${method}: at most ${MAX_FILES_AT_ONCE} files at once`);
  return [...new Set(value.map((id, i) => readId(id, method, `fileIds[${i}]`)))];
}

/**
 * Attach files to the open draft (`composerId`, compose:write) or to a new
 * one (`newDraft`, compose:open), by their blobs: no download, no upload.
 * Either way each file passes onBeforeAttachmentUpload and the server's
 * limit for all attachments of a message: the open composer checks them
 * itself; for a new draft they are checked here, before compose.open.
 */
export async function doFilesAttach(plugin: InstalledPlugin, idsArg: unknown, targetArg: unknown): Promise<FileAttachResult> {
  const method = 'files.attach';
  const ids = readFileIds(method, idsArg);
  if (!isPlainRecord(targetArg)) throw new Error(`${method}: say where: { composerId } or { newDraft }`);
  const target = readObject(targetArg, method, 'target', ['composerId', 'newDraft']);
  if ((target.composerId === undefined) === (target.newDraft === undefined)) throw new Error(`${method}: give either composerId or newDraft`);
  needPermission(plugin, method, target.composerId !== undefined ? 'compose:write' : 'compose:open');
  const client = needFiles(method);
  if (!withinRate(method, plugin.id, MAX_FILES_AT_ONCE)) throw new Error(`${method}: at most ${MAX_FILES_AT_ONCE} times a minute`);
  const nodes = visibleNodes(await allNodes(client));
  const files = ids.map((id) => findNode(method, nodes, id));
  const folder = files.find((n) => isFolder(n) || !n.blobId);
  if (folder) throw new Error(`${method}: "${folder.name}" is a folder; only files can be attached`);
  const refs = files.map((n) => ({ blobId: n.blobId as string, name: n.name || 'file', type: attachType(n.type || ''), size: n.size || 0 }));

  if (target.composerId !== undefined) {
    const handle = composerHandle(readId(target.composerId, method, 'composerId'));
    if (!handle) throw new Error(`${method}: that composer is not open any more`);
    // The login whose Files hold the blobs: a draft sent from another login copies them first.
    const sourceAccountId = useAuthStore.getState().activeAccountId ?? undefined;
    const attached: string[] = [];
    const refused: string[] = [];
    for (const ref of refs) {
      const ok = handle.attachFile ? await handle.attachFile({ ...ref, sourceAccountId }) : await handle.attach(ref);
      (ok ? attached : refused).push(ref.name);
    }
    return { attached, refused };
  }

  const draft = readObject(target.newDraft, method, 'newDraft', ['to', 'subject', 'body']);
  const refused: string[] = [];
  const passed: typeof refs = [];
  for (const ref of refs) {
    if (await emailHooks.onBeforeAttachmentUpload.intercept({ name: ref.name, type: ref.type, size: ref.size })) passed.push(ref);
    else refused.push(ref.name);
  }
  const maxTotal = client.getMaxSizeAttachmentsPerEmail?.() ?? 0;
  let total = 0;
  const fitting = passed.filter((ref) => {
    if (maxTotal > 0 && total + ref.size > maxTotal) { refused.push(ref.name); return false; }
    total += ref.size;
    return true;
  });
  if (!fitting.length) return { attached: [], refused };
  // compose.open checks the addresses, the subject and the body, and asks before it replaces an open draft.
  doComposeOpen(plugin, { ...draft, attachments: fitting });
  return { attached: fitting.map((r) => r.name), refused };
}

// ─── Writing: only the user's own drive, never a shared folder ───

interface OwnDrive {
  client: IJMAPClient;
  /** The user's own drive, read fresh (with shareWith). */
  nodes: FileNode[];
  byId: Map<string, FileNode>;
  trashed: Set<string>;
}

async function ownDrive(method: string): Promise<OwnDrive> {
  const client = needFiles(method);
  const nodes = (await client.listAllFileNodes()).filter((n) => !n.isShared);
  return { client, nodes, byId: new Map(nodes.map((n) => [n.id, n])), trashed: trashSubtreeIds(nodes, findTrashFolder(nodes)?.id) };
}

const sharedOut = (node: FileNode) => !!node.shareWith && Object.keys(node.shareWith).length > 0;

/**
 * Whether `node` or a folder above it is shared with someone: 'shared',
 * 'own', or 'unknown' when a folder on the way up is not in the listing
 * (a listing cut short, or a node that moved meanwhile), which counts as
 * shared.
 */
function placeOf(drive: OwnDrive, node: FileNode): 'own' | 'shared' | 'unknown' {
  const seen = new Set<string>();
  for (let at: FileNode | undefined = node; at; ) {
    if (seen.has(at.id)) return 'unknown';
    seen.add(at.id);
    if (sharedOut(at)) return 'shared';
    if (at.parentId == null) return 'own';
    at = drive.byId.get(at.parentId);
    if (!at) return 'unknown';
  }
  return 'unknown';
}

/** A node of the user's own drive, outside the trash, not in a shared folder. */
function ownNode(method: string, drive: OwnDrive, id: string): FileNode {
  if (id.includes(':')) throw new Error(`${method}: that file is in a drive someone shared with you; the assistant only changes your own files`);
  const node = drive.byId.get(id);
  if (!node || drive.trashed.has(node.id) || fileNodeKind(node) === 'symlink') throw new Error(`${method}: no file or folder with id "${id}" in your own files`);
  const place = placeOf(drive, node);
  if (place === 'shared') throw new Error(`${method}: "${node.name}" is shared with others; the assistant doesn't change shared files`);
  if (place === 'unknown') throw new Error(`${method}: the folders above "${node.name}" couldn't be read, so it can't tell whether they are shared; try again`);
  return node;
}

/** A folder of the user's own drive to write into (null: the top), outside the trash, not shared. */
function ownFolder(method: string, drive: OwnDrive, id: string | null): FileNode | null {
  if (id === null) return null;
  const folder = ownNode(method, drive, id);
  if (!isFolder(folder)) throw new Error(`${method}: "${folder.name}" is not a folder`);
  return folder;
}

const pathOf = (drive: OwnDrive, folder: FileNode | null) => (folder ? (pathOfNode(drive.nodes, folder) === '/' ? `/${folder.name}` : `${pathOfNode(drive.nodes, folder)}/${folder.name}`) : '/');

function readFolderId(method: string, value: unknown, field = 'folderId'): string | null {
  return value === undefined || value === null ? null : readId(value, method, field);
}

function problemText(problem: FileNameProblem): string {
  switch (problem.kind) {
    case 'chars': return `the name may not contain ${problem.chars}`;
    case 'control': return 'the name may not contain control characters';
    case 'tooLong': return 'the name is too long';
    case 'reserved': return 'that name is reserved by the server';
  }
}

/** A new name the server takes: refused with the reason, never changed behind the user's back. */
function readNewName(method: string, client: IJMAPClient, value: unknown): string {
  const raw = readString(value, method, 'name', 255, { min: 1 });
  // eslint-disable-next-line no-control-regex -- refused, as Stalwart 1.0 does, rather than changed
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) throw new Error(`${method}: the name may not contain control characters`);
  const name = raw.trim();
  if (!name) throw new Error(`${method}: the name is empty`);
  if (name === '.' || name === '..' || name.includes('/')) throw new Error(`${method}: "${name}" can't be a file name`);
  if (name === TRASH_FOLDER_NAME) throw new Error(`${method}: "${name}" is the Files trash's name`);
  const problem = fileNameProblem(name, client.getFileNameRules?.() ?? null);
  if (problem) throw new Error(`${method}: ${problemText(problem)}`);
  return name;
}

/** After a change: fresh listings for the assistant and search, and the Files view if it is open. */
function afterWrite(): void {
  forgetFileListing();
  invalidateFileSearchCache();
  const files = useFileStore.getState();
  if (files.client && files.hasListed) void files.refresh().catch(() => {});
}

const STOPPED = 'another plugin stopped this';

/**
 * Save attachments of a message into a folder of the user's own drive, by
 * their blobs (lib/files-save.ts, as the reader's Save to Files). Needs
 * email:read too. A name that is taken becomes "name (2).ext".
 */
export async function doFilesSaveAttachments(plugin: InstalledPlugin, emailArg: unknown, blobsArg: unknown, folderArg?: unknown, optionsArg?: unknown): Promise<{ saved: FileInfo[]; stopped: string[] }> {
  const method = 'files.saveAttachments';
  needPermission(plugin, method, 'email:read');
  const emailId = readId(emailArg, method, 'emailId');
  if (!Array.isArray(blobsArg) || blobsArg.length === 0) throw new Error(`${method}: blobIds must be a list of attachment blob ids`);
  if (blobsArg.length > MAX_FILES_AT_ONCE) throw new Error(`${method}: at most ${MAX_FILES_AT_ONCE} attachments at once`);
  const blobIds = [...new Set(blobsArg.map((b, i) => readId(b, method, `blobIds[${i}]`)))];
  const folderId = readFolderId(method, folderArg);
  const opts = readObject(optionsArg, method, 'options', ['accountId'], true);
  // Counted before anything is read: a refused write counts too, and costs no listing.
  countWrite(method, plugin);
  const drive = await ownDrive(method);
  const folder = ownFolder(method, drive, folderId);
  const found = await readNamedEmail(drive.client, emailId, method, opts.accountId);
  if (!found) throw new Error(`${method}: no message with id "${emailId}"`);
  const parts = blobIds.map((blobId) => {
    const part = (found.email.attachments ?? []).find((a) => a.blobId === blobId);
    if (!part) throw new Error(`${method}: that blob is not an attachment of this message`);
    return { blobId, name: part.name, type: part.type, size: part.size || 0 };
  });
  const path = pathOf(drive, folder);
  const { saved, stopped } = await saveBlobsToFiles(parts, {
    client: drive.client, parentId: folder?.id ?? null, path, blobAccountId: found.accountId ?? drive.client.getAccountId(),
  });
  if (saved.length) afterWrite();
  return {
    saved: saved.map((node) => ({ ...infoOf(node, drive.nodes), path, parentId: folder?.id ?? null, size: node.size || 0 })),
    stopped,
  };
}

const isTextFile = (node: FileNode) => /\.(md|markdown|txt|text)$/i.test(node.name) || /^text\/(plain|markdown)\b/i.test(node.type || '');

/**
 * A new text or Markdown file, or new content for one (`replace`): the old
 * version is kept as a copy in the Files trash first, where Restore brings
 * it back next to the new one. The copy points at the old blob, so it
 * costs no space.
 */
export async function doFilesCreate(plugin: InstalledPlugin, inputArg: unknown): Promise<FileCreateResult> {
  const method = 'files.create';
  const input = readObject(inputArg, method, 'input', ['folderId', 'name', 'content', 'type', 'replace']);
  const content = readString(input.content, method, 'content', MAX_CREATE_CHARS);
  if (!(TEXT_TYPES as readonly unknown[]).includes(input.type)) throw new Error(`${method}: type must be text/markdown or text/plain`);
  const type = input.type as typeof TEXT_TYPES[number];
  const replaceId = input.replace === undefined ? null : readId(input.replace, method, 'replace');
  // Counted before anything is read: a refused write counts too, and costs no listing.
  countWrite(method, plugin);
  const drive = await ownDrive(method);
  const { client } = drive;

  if (replaceId !== null) {
    const node = ownNode(method, drive, replaceId);
    if (isFolder(node) || !node.blobId) throw new Error(`${method}: "${node.name}" is a folder`);
    if (!isTextFile(node)) throw new Error(`${method}: only text and Markdown files can be replaced; "${node.name}" is not one`);
    const parent = node.parentId ? drive.byId.get(node.parentId) ?? null : null;
    const path = pathOf(drive, parent);
    const file = new File([content], node.name, { type: node.type || type });
    if (!(await fileHooks.onBeforeFileUpload.intercept({ name: node.name, size: file.size, type: file.type, path }))) throw new Error(`${method}: ${STOPPED}`);
    const uploaded = await client.uploadBlob(file);
    // The old version first: a copy of the node, pointing at the old blob, in a trash folder of its own.
    const trash = findTrashFolder(drive.nodes) ?? await client.createFileDirectory(TRASH_FOLDER_NAME, null);
    const batch = await client.createFileDirectory(trashBatchName(node.parentId ?? null), trash.id);
    const kept = await client.createFileNode(node.name, node.blobId, node.type || type, node.size || 0, batch.id);
    try {
      await client.replaceFileNodeBlob(node.id, uploaded.blobId);
    } catch (error) {
      // Nothing changed: take the copy out of the trash again, so no stray old version stays there.
      await client.destroyFileNodes([batch.id]).catch(() => {});
      throw error;
    }
    const now = new Date().toISOString();
    const replaced: FileNode = { ...node, blobId: uploaded.blobId, size: uploaded.size ?? file.size, modified: now };
    void fileHooks.onAfterFileUpload.emit(fileToView(replaced, path));
    afterWrite();
    return { file: infoOf(replaced, drive.nodes), kept: { trashFolder: TRASH_FOLDER_NAME, name: kept.name } };
  }

  const name = readNewName(method, client, input.name);
  const folder = ownFolder(method, drive, readFolderId(method, input.folderId));
  const path = pathOf(drive, folder);
  const file = new File([content], name, { type });
  if (!(await fileHooks.onBeforeFileUpload.intercept({ name, size: file.size, type, path }))) throw new Error(`${method}: ${STOPPED}`);
  const uploaded = await client.uploadBlob(file);
  // A name that is taken becomes "name (2).md" on the server: nothing is overwritten.
  const node = await client.createFileNode(name, uploaded.blobId, type, uploaded.size ?? file.size, folder?.id ?? null);
  void fileHooks.onAfterFileUpload.emit(fileToView(node, path));
  afterWrite();
  return { file: { ...infoOf(node, drive.nodes), path, parentId: folder?.id ?? null, size: node.size || uploaded.size || file.size, mimeType: type } };
}

/** A new folder in the user's own drive; a name that is taken becomes "name (2)". */
export async function doFilesCreateFolder(plugin: InstalledPlugin, inputArg: unknown): Promise<FileInfo> {
  const method = 'files.createFolder';
  const input = readObject(inputArg, method, 'input', ['parentId', 'name']);
  // Counted before anything is read: a refused write counts too, and costs no listing.
  countWrite(method, plugin);
  const drive = await ownDrive(method);
  const name = readNewName(method, drive.client, input.name);
  const parent = ownFolder(method, drive, readFolderId(method, input.parentId, 'parentId'));
  const maxDepth = drive.client.getMaxFileNodeDepth?.() ?? null;
  if (maxDepth !== null) {
    let depth = 1;
    for (let at = parent; at; at = at.parentId ? drive.byId.get(at.parentId) ?? null : null) depth++;
    if (depth > maxDepth) throw new Error(`${method}: folders can't be nested deeper than ${maxDepth} levels`);
  }
  const path = pathOf(drive, parent);
  const created = await drive.client.createFileDirectory(name, parent?.id ?? null);
  void fileHooks.onDirectoryCreate.emit(fileToView(created, path));
  afterWrite();
  return { ...infoOf(created, drive.nodes), path, parentId: parent?.id ?? null, kind: 'folder', mimeType: '', size: 0 };
}

/**
 * Move a file or folder within the user's own drive (null: to the top).
 * Never into or out of a shared folder, the trash or another account.
 * `previousFolderId` is where it was, for an Undo that moves it back.
 */
export async function doFilesMove(plugin: InstalledPlugin, fileArg: unknown, folderArg: unknown): Promise<{ file: FileInfo; previousFolderId: string | null }> {
  const method = 'files.move';
  const fileId = readId(fileArg, method, 'fileId');
  const folderId = readFolderId(method, folderArg);
  if (folderId !== null && folderId.includes(':')) throw new Error(`${method}: files can't be moved to another person's drive`);
  // Counted before anything is read: a refused write counts too, and costs no listing.
  countWrite(method, plugin);
  const drive = await ownDrive(method);
  const node = ownNode(method, drive, fileId);
  const target = ownFolder(method, drive, folderId);
  const from = node.parentId ?? null;
  if ((target?.id ?? null) === from) throw new Error(`${method}: "${node.name}" is already there`);
  for (let at = target; at; at = at.parentId ? drive.byId.get(at.parentId) ?? null : null) {
    if (at.id === node.id) throw new Error(`${method}: a folder can't be moved into itself`);
  }
  const clash = drive.nodes.find((n) => (n.parentId ?? null) === (target?.id ?? null) && n.name === node.name && n.id !== node.id);
  if (clash) throw new Error(`${method}: there is already something named "${node.name}" there`);
  const fromPath = pathOf(drive, from ? drive.byId.get(from) ?? null : null);
  const toPath = pathOf(drive, target);
  if (!(await fileHooks.onBeforeFileMove.intercept({ files: [fileToView(node, fromPath)], toPath }))) throw new Error(`${method}: ${STOPPED}`);
  await drive.client.updateFileNode(node.id, { parentId: target?.id ?? null });
  // As the Files store reports a move: the item as it was, from where it was.
  void fileHooks.onFileMove.emit({ files: [fileToView(node, fromPath)], toPath });
  afterWrite();
  return { file: { ...infoOf(node, drive.nodes), path: toPath, parentId: target?.id ?? null }, previousFolderId: from };
}

/** Rename a file or folder of the user's own drive. `previousName` is for an Undo. */
export async function doFilesRename(plugin: InstalledPlugin, fileArg: unknown, nameArg: unknown): Promise<{ file: FileInfo; previousName: string }> {
  const method = 'files.rename';
  const fileId = readId(fileArg, method, 'fileId');
  // Counted before anything is read: a refused write counts too, and costs no listing.
  countWrite(method, plugin);
  const drive = await ownDrive(method);
  const name = readNewName(method, drive.client, nameArg);
  const node = ownNode(method, drive, fileId);
  if (name === node.name) throw new Error(`${method}: it is already called "${name}"`);
  const clash = drive.nodes.find((n) => (n.parentId ?? null) === (node.parentId ?? null) && n.name === name && n.id !== node.id);
  if (clash) throw new Error(`${method}: there is already something named "${name}" in that folder`);
  const path = pathOf(drive, node.parentId ? drive.byId.get(node.parentId) ?? null : null);
  const view = fileToView(node, path);
  if (!(await fileHooks.onBeforeFileRename.intercept({ file: view, newName: name }))) throw new Error(`${method}: ${STOPPED}`);
  await drive.client.updateFileNode(node.id, { name });
  void fileHooks.onFileRename.emit({ file: { ...view, name }, previousName: node.name });
  afterWrite();
  return { file: { ...infoOf({ ...node, name }, drive.nodes), path }, previousName: node.name };
}

/** Runs a method of this area; NOT_MINE for any other. */
export async function dispatch(plugin: InstalledPlugin, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'files.find': return doFilesFind(plugin, args[0]);
    case 'files.list': return doFilesList(plugin, args[0]);
    case 'files.getText': return doFilesGetText(plugin, args[0], args[1]);
    case 'files.getImage': return doFilesGetImage(plugin, args[0], args[1]);
    case 'files.attach': return doFilesAttach(plugin, args[0], args[1]);
    case 'files.saveAttachments': return doFilesSaveAttachments(plugin, args[0], args[1], args[2], args[3]);
    case 'files.create': return doFilesCreate(plugin, args[0]);
    case 'files.createFolder': return doFilesCreateFolder(plugin, args[0]);
    case 'files.move': return doFilesMove(plugin, args[0], args[1]);
    case 'files.rename': return doFilesRename(plugin, args[0], args[1]);
    default: return NOT_MINE;
  }
}

/** This area's flags in api.host.features, right now. */
export function features(): AreaHostFeaturesD {
  return { files: filesAvailable() };
}
