import { postJmap, fetchJmapSession, rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import type { FileNode } from '@/lib/jmap/types';

/**
 * Server-side JMAP FileNode content I/O for the WOPI host (#425).
 *
 * The WOPI client calls CheckFileInfo/GetFile/PutFile server-to-server, so
 * this module talks to the JMAP server directly with the credentials carried
 * in the (encrypted) access token. Content is addressed purely via JMAP -
 * blob download for GetFile, blob upload + `FileNode/set { blobId }` for
 * PutFile - which sidesteps the DAV name-encoding quirks (#869) and works
 * regardless of where the node sits in the folder tree.
 */

export interface WopiJmapContext {
  serverUrl: string;
  authHeader: string;
  /** Mirrors StalwartCredentials.trusted - false routes via the rebinding-safe fetch. */
  trusted: boolean;
}

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:filenode'];

export const WOPI_FILE_NODE_PROPERTIES = [
  'id', 'parentId', 'name', 'type', 'blobId', 'size', 'modified', 'myRights',
];

type JmapMethodResponse = [string, Record<string, unknown>, string];

async function callJmap(ctx: WopiJmapContext, methodCalls: unknown[]): Promise<JmapMethodResponse[]> {
  const body = JSON.stringify({ using: USING, methodCalls });
  const options = { trusted: ctx.trusted };
  const directUrl = `${ctx.serverUrl}/jmap/`;
  let response = await postJmap(directUrl, ctx.authHeader, body, options);

  if (response.status === 404) {
    // Same recovery as the JMAP passthrough (#627): resolve the session's
    // advertised apiUrl rebased onto the reachable host and retry once.
    const session = await fetchJmapSession(ctx.serverUrl, ctx.authHeader, options);
    const apiUrl = rebaseApiUrl(session, ctx.serverUrl);
    if (apiUrl && apiUrl !== directUrl) {
      response = await postJmap(apiUrl, ctx.authHeader, body, options);
    }
  }

  if (!response.ok) {
    throw new Error(`JMAP request failed (${response.status})`);
  }
  const json = (await response.json()) as { methodResponses?: JmapMethodResponse[] };
  return json.methodResponses ?? [];
}

export async function getWopiFileNode(
  ctx: WopiJmapContext,
  accountId: string,
  fileId: string,
): Promise<FileNode | null> {
  const responses = await callJmap(ctx, [
    ['FileNode/get', { accountId, ids: [fileId], properties: WOPI_FILE_NODE_PROPERTIES }, 'g0'],
  ]);
  const [name, payload] = responses[0] ?? [];
  if (name !== 'FileNode/get') return null;
  const list = (payload?.list as FileNode[] | undefined) ?? [];
  return list[0] ?? null;
}

// The session's download/upload templates advertise the server's public
// hostname, which this process may not be able to reach (see rebaseApiUrl) -
// keep the template's path but rebase onto the stored serverUrl's origin.
// Falls back to Stalwart's canonical paths when no session is available.
const FALLBACK_DOWNLOAD_PATH = '/jmap/download/{accountId}/{blobId}/{name}?accept={type}';
const FALLBACK_UPLOAD_PATH = '/jmap/upload/{accountId}/';

const blobUrlCache = new Map<string, { fetchedAt: number; downloadUrl: string; uploadUrl: string }>();
const BLOB_URL_TTL_MS = 5 * 60 * 1000;

function rebaseTemplate(template: string | undefined, serverUrl: string, fallbackPath: string): string {
  const origin = new URL(serverUrl).origin;
  if (!template) return origin + fallbackPath;
  // Not parsed with `new URL` - the {placeholders} would get percent-encoded.
  const path = template.replace(/^[a-z]+:\/\/[^/]+/i, '');
  return origin + (path.startsWith('/') ? path : `/${path}`);
}

async function getBlobUrls(ctx: WopiJmapContext): Promise<{ downloadUrl: string; uploadUrl: string }> {
  const cached = blobUrlCache.get(ctx.serverUrl);
  if (cached && Date.now() - cached.fetchedAt < BLOB_URL_TTL_MS) return cached;

  let downloadTemplate: string | undefined;
  let uploadTemplate: string | undefined;
  try {
    const session = await fetchJmapSession(ctx.serverUrl, ctx.authHeader, { trusted: ctx.trusted }) as
      | ({ downloadUrl?: string; uploadUrl?: string } & Record<string, unknown>)
      | null;
    downloadTemplate = session?.downloadUrl;
    uploadTemplate = session?.uploadUrl;
  } catch {
    // Fall through to the canonical Stalwart paths.
  }

  const entry = {
    fetchedAt: Date.now(),
    downloadUrl: rebaseTemplate(downloadTemplate, ctx.serverUrl, FALLBACK_DOWNLOAD_PATH),
    uploadUrl: rebaseTemplate(uploadTemplate, ctx.serverUrl, FALLBACK_UPLOAD_PATH),
  };
  blobUrlCache.set(ctx.serverUrl, entry);
  return entry;
}

function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (match, key: string) =>
    key in vars ? encodeURIComponent(vars[key]) : match,
  );
}

/** Stream a blob's content from the JMAP server (WOPI GetFile). */
export async function downloadFileBlob(
  ctx: WopiJmapContext,
  accountId: string,
  blobId: string,
  name: string,
  type: string,
  signal?: AbortSignal,
): Promise<Response> {
  const { downloadUrl } = await getBlobUrls(ctx);
  const url = expandTemplate(downloadUrl, {
    accountId,
    blobId,
    name,
    type: type || 'application/octet-stream',
  });
  return fetchJmapServer(url, {
    method: 'GET',
    headers: { Authorization: ctx.authHeader },
    signal,
  }, ctx.trusted);
}

/**
 * Check that a mail attachment blob is readable with these credentials and
 * learn its size (#1047). Only the response headers are read; the request
 * is aborted before the body. Returns null when the blob cannot be downloaded.
 */
export async function probeBlob(
  ctx: WopiJmapContext,
  accountId: string,
  blobId: string,
  name: string,
  type: string,
): Promise<{ size: number | null } | null> {
  // Abort instead of awaiting body.cancel(): that await never settled
  // against the Next dev server, hanging the launch until the browser gave up.
  const controller = new AbortController();
  const response = await downloadFileBlob(ctx, accountId, blobId, name, type, controller.signal);
  controller.abort();
  if (!response.ok) return null;
  const length = Number(response.headers.get('Content-Length'));
  return { size: Number.isFinite(length) && length >= 0 && response.headers.has('Content-Length') ? length : null };
}

/** Upload new content as a blob (first half of WOPI PutFile). */
export async function uploadFileBlob(
  ctx: WopiJmapContext,
  accountId: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<{ blobId: string; size: number; type: string }> {
  const { uploadUrl } = await getBlobUrls(ctx);
  const url = expandTemplate(uploadUrl, { accountId });
  const response = await fetchJmapServer(url, {
    method: 'POST',
    headers: {
      Authorization: ctx.authHeader,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body,
  }, ctx.trusted);
  if (!response.ok) {
    throw new Error(`Blob upload failed (${response.status})`);
  }
  const json = (await response.json()) as { blobId?: string; size?: number; type?: string };
  if (!json.blobId) throw new Error('Blob upload returned no blobId');
  return { blobId: json.blobId, size: json.size ?? body.byteLength, type: json.type ?? contentType };
}

/**
 * Point an existing FileNode at a new content blob (second half of PutFile).
 * Returns the node's post-update `modified` timestamp.
 */
export async function updateFileNodeBlob(
  ctx: WopiJmapContext,
  accountId: string,
  fileId: string,
  blobId: string,
): Promise<{ modified: string }> {
  const responses = await callJmap(ctx, [
    ['FileNode/set', { accountId, update: { [fileId]: { blobId } } }, 's0'],
    ['FileNode/get', { accountId, ids: [fileId], properties: ['id', 'modified'] }, 'g1'],
  ]);

  const [setName, setPayload] = responses[0] ?? [];
  if (setName !== 'FileNode/set') {
    throw new Error((setPayload?.description as string) || 'FileNode/set failed');
  }
  const updated = setPayload?.updated as Record<string, unknown> | undefined;
  if (!updated || !(fileId in updated)) {
    const notUpdated = setPayload?.notUpdated as Record<string, { description?: string }> | undefined;
    throw new Error(notUpdated?.[fileId]?.description || 'FileNode content update rejected');
  }

  const getPayload = responses[1]?.[1];
  const node = ((getPayload?.list as FileNode[] | undefined) ?? [])[0];
  return { modified: node?.modified ?? new Date().toISOString() };
}
