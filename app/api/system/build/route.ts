import { NextResponse } from 'next/server';

// Public, cheap and never cached: the stamp of the build serving this request.
// A tab whose own stamp differs was loaded before the last deploy and should
// refresh itself (components/build-refresh.tsx). No secrets, no versions.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { stamp: process.env.NEXT_PUBLIC_BUILD_STAMP || '' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
