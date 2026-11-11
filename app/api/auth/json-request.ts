import { NextResponse } from 'next/server';

/**
 * Gate for the sign-in and session routes that read a JSON body and act with
 * or write the browser's cookies. The app calls them with fetch and a JSON
 * content type; an HTML form can only send form encodings or text/plain,
 * which `request.json()` would otherwise accept just the same. Returns a 415
 * for any other content type, and null when the handler may go on. Runs
 * before the body is read.
 */
export function rejectNonJsonBody(request: Request): NextResponse | null {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (type === 'application/json' || /^application\/[\w.-]+\+json$/.test(type)) return null;
  return NextResponse.json({ error: 'Expected a JSON body' }, { status: 415 });
}
