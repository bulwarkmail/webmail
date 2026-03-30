import { NextRequest, NextResponse } from 'next/server';
import { generateRoomName, buildMeetingUrl, createJitsiJwt } from '@/lib/jitsi';

/**
 * POST /api/jitsi — Create a Jitsi meeting URL.
 *
 * Request body: { eventTitle: string, userEmail?: string, userName?: string }
 * Response:     { url: string }
 *
 * Returns 404 when JITSI_URL is not configured so the feature stays invisible.
 */
export async function POST(request: NextRequest) {
  const jitsiUrl = process.env.JITSI_URL;
  if (!jitsiUrl) {
    return NextResponse.json({ error: 'Jitsi integration is not configured' }, { status: 404 });
  }

  let body: { eventTitle?: string; userEmail?: string; userName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { eventTitle, userEmail, userName } = body;
  if (!eventTitle || typeof eventTitle !== 'string') {
    return NextResponse.json({ error: 'eventTitle is required' }, { status: 400 });
  }

  const roomName = generateRoomName(eventTitle);
  let url = buildMeetingUrl(jitsiUrl, roomName);

  const jwtSecret = process.env.JITSI_JWT_SECRET;
  if (jwtSecret) {
    const token = await createJitsiJwt({
      secret: jwtSecret,
      roomName,
      userEmail,
      userName,
      jitsiUrl,
    });
    url += `?jwt=${token}`;
  }

  return NextResponse.json({ url });
}
