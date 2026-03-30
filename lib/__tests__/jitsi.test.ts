import { describe, it, expect } from 'vitest';
import { generateRoomName, buildMeetingUrl, createJitsiJwt } from '../jitsi';

describe('generateRoomName', () => {
  it('should slugify the event title and append a random suffix', () => {
    const room = generateRoomName('Team Standup');
    expect(room).toMatch(/^team-standup-[a-f0-9]{8}$/);
  });

  it('should handle special characters', () => {
    const room = generateRoomName('Q&A Session: "Ask Me Anything!"');
    expect(room).toMatch(/^q-a-session-ask-me-anything-[a-f0-9]{8}$/);
  });

  it('should handle empty title', () => {
    const room = generateRoomName('');
    expect(room).toMatch(/^[a-f0-9]{8}$/);
  });

  it('should handle whitespace-only title', () => {
    const room = generateRoomName('   ');
    expect(room).toMatch(/^[a-f0-9]{8}$/);
  });

  it('should truncate long titles to 60 chars plus suffix', () => {
    const longTitle = 'A'.repeat(100);
    const room = generateRoomName(longTitle);
    // 60 chars of slug + '-' + 8 char suffix = 69 max
    expect(room.length).toBeLessThanOrEqual(69);
  });

  it('should generate unique room names for the same title', () => {
    const room1 = generateRoomName('Standup');
    const room2 = generateRoomName('Standup');
    expect(room1).not.toBe(room2);
  });
});

describe('buildMeetingUrl', () => {
  it('should combine base URL and room name', () => {
    const url = buildMeetingUrl('https://meet.example.com', 'my-room-abc12345');
    expect(url).toBe('https://meet.example.com/my-room-abc12345');
  });

  it('should strip trailing slashes from base URL', () => {
    const url = buildMeetingUrl('https://meet.example.com/', 'room');
    expect(url).toBe('https://meet.example.com/room');
  });

  it('should strip multiple trailing slashes', () => {
    const url = buildMeetingUrl('https://meet.example.com///', 'room');
    expect(url).toBe('https://meet.example.com/room');
  });

  it('should URL-encode the room name', () => {
    const url = buildMeetingUrl('https://meet.example.com', 'room with spaces');
    expect(url).toBe('https://meet.example.com/room%20with%20spaces');
  });
});

describe('createJitsiJwt', () => {
  it('should create a valid HS256 JWT', async () => {
    const token = await createJitsiJwt({
      secret: 'test-secret-key',
      roomName: 'test-room',
      userEmail: 'user@example.com',
      userName: 'Test User',
      jitsiUrl: 'https://meet.example.com',
    });

    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    // Decode header
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');

    // Decode payload
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.iss).toBe('bulwark-webmail');
    expect(payload.sub).toBe('meet.example.com');
    expect(payload.aud).toBe('jitsi');
    expect(payload.room).toBe('test-room');
    expect(payload.context.user.name).toBe('Test User');
    expect(payload.context.user.email).toBe('user@example.com');
    expect(payload.exp).toBe(payload.iat + 86400);
  });

  it('should set the sub claim to the Jitsi hostname', async () => {
    const token = await createJitsiJwt({
      secret: 'secret',
      roomName: 'room',
      jitsiUrl: 'https://jitsi.corp.example.com/subfolder',
    });

    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.sub).toBe('jitsi.corp.example.com');
  });

  it('should omit undefined user fields', async () => {
    const token = await createJitsiJwt({
      secret: 'secret',
      roomName: 'room',
      jitsiUrl: 'https://meet.example.com',
    });

    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.context.user.name).toBeUndefined();
    expect(payload.context.user.email).toBeUndefined();
  });

  it('should produce a different signature with different secrets', async () => {
    const token1 = await createJitsiJwt({
      secret: 'secret-one',
      roomName: 'room',
      jitsiUrl: 'https://meet.example.com',
    });
    const token2 = await createJitsiJwt({
      secret: 'secret-two',
      roomName: 'room',
      jitsiUrl: 'https://meet.example.com',
    });

    const sig1 = token1.split('.')[2];
    const sig2 = token2.split('.')[2];
    expect(sig1).not.toBe(sig2);
  });

  it('should produce a verifiable HMAC-SHA256 signature', async () => {
    const secret = 'my-test-secret';
    const token = await createJitsiJwt({
      secret,
      roomName: 'verify-room',
      jitsiUrl: 'https://meet.example.com',
    });

    const [headerB64, payloadB64, signatureB64] = token.split('.');
    const signingInput = `${headerB64}.${payloadB64}`;

    // Re-compute HMAC to verify
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    // Decode the base64url signature
    const sigPadded = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
    const sigBinary = atob(sigPadded);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      sigBytes[i] = sigBinary.charCodeAt(i);
    }

    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(signingInput));
    expect(valid).toBe(true);
  });
});
