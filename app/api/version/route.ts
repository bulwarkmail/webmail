import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * The id of the build this server runs (next.config.ts BULWARK_BUILD_ID),
 * for open tabs to notice a deploy (#523, components/app-update-prompt.tsx).
 * Only the id: a hash that says nothing about the version or the commit,
 * and the same id every page of the build carries anyway.
 */
export function GET() {
  return NextResponse.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? '' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
