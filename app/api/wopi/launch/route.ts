import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';
import { getWopiActions, buildWopiActionUrl } from '@/lib/wopi/discovery';
import { getWopiFileNode, probeBlob } from '@/lib/wopi/files';
import { mintWopiToken, wopiDocumentId, type WopiTokenPayload } from '@/lib/wopi/token';
import { wopiBrowserBinding } from '@/lib/wopi/revocation';

/**
 * POST /api/wopi/launch
 *   { fileId: string, accountId?: string }                          - a Files node
 *   { blobId: string, name: string, type?: string, accountId?: string } - a mail attachment
 *
 * Mints a WOPI access token scoped to one document and returns the editor
 * URL to POST it to (#425). Attachments always open read-only (#1047).
 * Session-authenticated - this is the only WOPI route the browser calls;
 * everything under /api/wopi/files is called by the editor server-to-server
 * with the token minted here.
 */
export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (key: string): string => (typeof body?.[key] === 'string' ? (body[key] as string) : '');
    const fileId = str('fileId');
    const blobId = str('blobId');
    const attachmentName = str('name').trim();
    if (!fileId && !blobId) {
      return NextResponse.json({ error: 'fileId or blobId is required' }, { status: 400 });
    }
    if (blobId && !attachmentName) {
      return NextResponse.json({ error: 'name is required for attachments' }, { status: 400 });
    }

    const actions = await getWopiActions();
    if (!actions) {
      return NextResponse.json({ error: 'No document editor is configured' }, { status: 503 });
    }

    // The dev mock stores a relative serverUrl (/api/dev-jmap); resolve it
    // against this request's origin so server-side calls can reach it. A
    // same-origin server (the mock) is this process itself - the public-URL
    // guard would refuse localhost, so it counts as trusted.
    const serverUrl = new URL(creds.serverUrl, request.nextUrl.origin).toString().replace(/\/+$/, '');
    const trusted = creds.trusted || new URL(serverUrl).origin === request.nextUrl.origin;
    const ctx = { serverUrl, authHeader: creds.authHeader, trusted };

    let accountId = str('accountId');
    const capability = blobId ? 'urn:ietf:params:jmap:mail' : 'urn:ietf:params:jmap:filenode';
    // Files need the session even with an explicit account: PutFile uploads
    // into the login's own account, which is not the one holding a node
    // shared with the user (#1094).
    const session = !accountId || !blobId
      ? await fetchJmapSession(serverUrl, creds.authHeader, { trusted })
      : null;
    const ownAccountId = session?.primaryAccounts?.[capability] || '';
    if (!accountId) {
      accountId = ownAccountId || Object.keys(session?.accounts ?? {})[0] || '';
    }
    if (!accountId) {
      return NextResponse.json({ error: blobId ? 'No mail account' : 'No files account' }, { status: 404 });
    }

    let document: Pick<WopiTokenPayload, 'kind' | 'fileId' | 'name' | 'type' | 'size' | 'uploadAccountId'>;
    let name: string;
    let canWrite: boolean;
    if (blobId) {
      const type = str('type');
      // Confirms the blob is readable with these credentials before the
      // editor is pointed at it, and reads its size for CheckFileInfo.
      const probe = await probeBlob(ctx, accountId, blobId, attachmentName, type);
      if (!probe) {
        return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
      }
      const clientSize = typeof body?.size === 'number' && body.size >= 0 ? body.size : 0;
      name = attachmentName;
      canWrite = false;
      document = { kind: 'attachment', fileId: blobId, name, type, size: probe.size ?? clientSize };
    } else {
      const node = await getWopiFileNode(ctx, accountId, fileId);
      if (!node || !node.blobId) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
      }
      name = node.name;
      canWrite = node.myRights ? !!node.myRights.mayModifyContent : true;
      document = { kind: 'file', fileId, uploadAccountId: ownAccountId || accountId };
    }

    const ext = name.split('.').pop()?.toLowerCase() || '';
    const urlsrc = (canWrite && actions.edit[ext]) || actions.view[ext] || actions.edit[ext];
    if (!urlsrc) {
      return NextResponse.json({ error: 'File type not supported by the editor' }, { status: 415 });
    }
    const editable = canWrite && !!actions.edit[ext];

    // Where the editor reaches this webmail. Deployments where the editor
    // sees a different host than the browser (docker networks, split DNS)
    // override it via wopiHostUrl.
    const hostBase =
      configManager.get<string>('wopiHostUrl', '').trim().replace(/\/+$/, '') ||
      request.nextUrl.origin;
    const tokenPayload = {
      serverUrl,
      authHeader: creds.authHeader,
      username: creds.username,
      accountId,
      ...document,
      canWrite: editable,
      origin: request.nextUrl.origin,
      // Signing out of this slot in this browser revokes the token.
      bid: wopiBrowserBinding(await cookies()),
      slot: creds.slot,
    };
    const wopiSrc = `${hostBase}/api/wopi/files/${wopiDocumentId(tokenPayload)}`;
    const { token, expiresAt } = mintWopiToken(tokenPayload);

    return NextResponse.json({
      url: buildWopiActionUrl(urlsrc, wopiSrc),
      accessToken: token,
      accessTokenTtl: expiresAt,
      readOnly: !editable,
    });
  } catch (error) {
    logger.error('WOPI launch failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
