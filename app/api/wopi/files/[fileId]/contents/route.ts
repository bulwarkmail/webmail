import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { downloadFileBlob, getWopiFileNode, updateFileNodeBlob, uploadFileBlob } from '@/lib/wopi/files';
import { wopiContext } from '@/lib/wopi/request';

/**
 * WOPI GetFile / PutFile (#425). Content flows purely over JMAP: GetFile
 * streams the node's blob (or, for a mail attachment, the attachment blob
 * itself - #1047), PutFile uploads the editor's bytes as a new blob into the
 * user's own account and points the FileNode at it via `FileNode/set { blobId }`.
 */

/**
 * GetFile answers on the webmail origin, and the type of the bytes comes
 * from the launch request or a user-settable FileNode property. Served
 * inline as `text/html` or `image/svg+xml` it would run script as the
 * webmail, so the response is always an inert download whatever the
 * source claims to be.
 */
const GET_FILE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/octet-stream',
  'Content-Disposition': 'attachment',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'no-store',
};

/** GET = GetFile */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  // The editor fetches this server-to-server and sends no Sec-Fetch headers.
  // A browser navigating to it, or loading it as a script or style, is not
  // the editor.
  const dest = request.headers.get('sec-fetch-dest');
  if (dest !== null && dest !== 'empty') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const { fileId: documentId } = await params;
    const auth = await wopiContext(request, documentId);
    if (!auth) {
      return NextResponse.json({ error: 'Invalid access token' }, { status: 401 });
    }

    const { payload } = auth;
    let source: { blobId: string; name: string; type: string };
    if (payload.kind === 'attachment') {
      source = { blobId: payload.fileId, name: payload.name || 'attachment', type: payload.type || '' };
    } else {
      const node = await getWopiFileNode(auth.ctx, payload.accountId, payload.fileId);
      if (!node || !node.blobId) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
      }
      source = { blobId: node.blobId, name: node.name, type: node.type };
    }

    const upstream = await downloadFileBlob(
      auth.ctx, payload.accountId, source.blobId, source.name, source.type,
    );
    if (!upstream.ok) {
      return NextResponse.json({ error: 'Blob download failed' }, { status: 502 });
    }

    const headers = new Headers(GET_FILE_HEADERS);
    const contentLength = upstream.headers.get('Content-Length');
    if (contentLength) headers.set('Content-Length', contentLength);
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (error) {
    logger.error('WOPI GetFile failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** POST = PutFile (X-WOPI-Override: PUT) */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  try {
    const { fileId: documentId } = await params;
    const auth = await wopiContext(request, documentId);
    if (!auth) {
      return NextResponse.json({ error: 'Invalid access token' }, { status: 401 });
    }
    if (!auth.payload.canWrite || auth.payload.kind === 'attachment') {
      return NextResponse.json({ error: 'Read-only token' }, { status: 403 });
    }

    const fileId = auth.payload.fileId;
    const node = await getWopiFileNode(auth.ctx, auth.payload.accountId, fileId);
    if (!node || !node.blobId) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Collabora sends the LastModifiedTime it saw at load/last save. A
    // mismatch means someone else changed the document meanwhile - answer
    // 409 + COOLStatusCode 1010 so the editor prompts the user instead of
    // silently overwriting.
    const clientStamp =
      request.headers.get('X-COOL-WOPI-Timestamp') || request.headers.get('X-LOOL-WOPI-Timestamp');
    if (clientStamp && node.modified) {
      const ours = Date.parse(node.modified);
      const theirs = Date.parse(clientStamp);
      if (Number.isFinite(ours) && Number.isFinite(theirs) && ours !== theirs) {
        return NextResponse.json({ COOLStatusCode: 1010 }, { status: 409 });
      }
    }

    const body = await request.arrayBuffer();
    if (body.byteLength === 0) {
      return NextResponse.json({ error: 'Empty document rejected' }, { status: 409 });
    }

    const blob = await uploadFileBlob(
      auth.ctx, auth.payload.uploadAccountId || auth.payload.accountId, body, node.type,
    );
    const { modified } = await updateFileNodeBlob(
      auth.ctx, auth.payload.accountId, fileId, blob.blobId,
    );

    return NextResponse.json({ LastModifiedTime: modified });
  } catch (error) {
    logger.error('WOPI PutFile failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
