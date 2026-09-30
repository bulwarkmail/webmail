import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { decodeFileNodeName } from '@/lib/jmap/filenode-name';
import { getWopiFileNode } from '@/lib/wopi/files';
import { wopiContext } from '@/lib/wopi/request';

/**
 * WOPI CheckFileInfo + file-level operations (#425).
 *
 * Called by the WOPI client (Collabora/OnlyOffice/EuroOffice) server-to-server
 * with the access token minted by /api/wopi/launch - there is no session
 * cookie on these requests.
 */

/** GET = CheckFileInfo */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  try {
    const { fileId: documentId } = await params;
    const auth = await wopiContext(request, documentId);
    if (!auth) {
      return NextResponse.json({ error: 'Invalid access token' }, { status: 401 });
    }

    const { payload } = auth;
    if (payload.kind === 'attachment') {
      // Mail attachments open read-only (#1047): the blob is immutable, so
      // its id doubles as the version and there is nothing to save back to.
      return NextResponse.json({
        BaseFileName: payload.name || 'attachment',
        Size: payload.size ?? 0,
        OwnerId: payload.username,
        UserId: payload.username,
        UserFriendlyName: payload.username,
        UserCanWrite: false,
        ReadOnly: true,
        UserCanNotWriteRelative: true,
        SupportsUpdate: false,
        SupportsLocks: false,
        Version: payload.fileId,
        PostMessageOrigin: payload.origin,
      });
    }

    const node = await getWopiFileNode(auth.ctx, payload.accountId, payload.fileId);
    if (!node || !node.blobId) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    return NextResponse.json({
      BaseFileName: decodeFileNodeName(node.name),
      Size: node.size,
      OwnerId: auth.payload.username,
      UserId: auth.payload.username,
      UserFriendlyName: auth.payload.username,
      UserCanWrite: auth.payload.canWrite,
      UserCanNotWriteRelative: true,
      SupportsUpdate: true,
      SupportsLocks: false,
      LastModifiedTime: node.modified,
      Version: node.blobId,
      PostMessageOrigin: auth.payload.origin,
    });
  } catch (error) {
    logger.error('WOPI CheckFileInfo failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const LOCK_OPERATIONS = new Set(['LOCK', 'UNLOCK', 'REFRESH_LOCK', 'GET_LOCK']);

/**
 * POST = lock operations. FileNodes have no lock concept to map these onto,
 * so they are acknowledged as no-ops (CheckFileInfo advertises
 * SupportsLocks: false; well-behaved clients don't send them at all).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId: documentId } = await params;
  const auth = await wopiContext(request, documentId);
  if (!auth) {
    return NextResponse.json({ error: 'Invalid access token' }, { status: 401 });
  }

  const operation = request.headers.get('X-WOPI-Override')?.toUpperCase() || '';
  if (LOCK_OPERATIONS.has(operation)) {
    const headers = new Headers();
    if (operation === 'GET_LOCK') headers.set('X-WOPI-Lock', '');
    return new NextResponse(null, { status: 200, headers });
  }
  return NextResponse.json({ error: 'Unsupported operation' }, { status: 501 });
}
