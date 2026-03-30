/**
 * Jitsi Meet integration — room name generation and optional JWT authentication.
 *
 * JITSI_URL        – base URL of the Jitsi instance (e.g. https://meet.example.com)
 * JITSI_JWT_SECRET – HMAC-SHA256 secret used to sign JWTs for authenticated Jitsi rooms
 */

/** Generate a URL-safe room name from an event title, with a random suffix for uniqueness. */
export function generateRoomName(eventTitle: string): string {
  const slug = eventTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  const suffix = crypto.randomUUID().slice(0, 8);
  return slug ? `${slug}-${suffix}` : suffix;
}

/** Build the full Jitsi meeting URL (without JWT). */
export function buildMeetingUrl(jitsiUrl: string, roomName: string): string {
  // Ensure no double slashes
  const base = jitsiUrl.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(roomName)}`;
}

/**
 * Create a HS256 JWT for Jitsi authentication.
 *
 * Uses the Web Crypto API so it works in both Node 18+ and edge runtimes.
 * The token is valid for 24 hours from creation.
 */
export async function createJitsiJwt(options: {
  secret: string;
  roomName: string;
  userEmail?: string;
  userName?: string;
  jitsiUrl: string;
}): Promise<string> {
  const { secret, roomName, userEmail, userName, jitsiUrl } = options;

  let domain: string;
  try {
    domain = new URL(jitsiUrl).hostname;
  } catch {
    domain = jitsiUrl;
  }

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    iss: 'bulwark-webmail',
    sub: domain,
    aud: 'jitsi',
    room: roomName,
    iat: now,
    exp: now + 86400, // 24 hours
    context: {
      user: {
        name: userName || undefined,
        email: userEmail || undefined,
      },
    },
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const signatureB64 = base64url(signature);

  return `${signingInput}.${signatureB64}`;
}

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
