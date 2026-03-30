import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

describe('POST /api/jitsi', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.JITSI_URL;
    delete process.env.JITSI_JWT_SECRET;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function callRoute(body: unknown) {
    const { POST } = await import('@/app/api/jitsi/route');
    const request = {
      json: async () => body,
    } as never;
    return POST(request);
  }

  it('should return 404 when JITSI_URL is not configured', async () => {
    const response = await callRoute({ eventTitle: 'Test' });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('not configured');
  });

  it('should return 400 when eventTitle is missing', async () => {
    process.env.JITSI_URL = 'https://meet.example.com';
    const response = await callRoute({});
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('eventTitle');
  });

  it('should return 400 when eventTitle is not a string', async () => {
    process.env.JITSI_URL = 'https://meet.example.com';
    const response = await callRoute({ eventTitle: 123 });
    expect(response.status).toBe(400);
  });

  it('should return a meeting URL without JWT when JITSI_JWT_SECRET is not set', async () => {
    process.env.JITSI_URL = 'https://meet.example.com';
    const response = await callRoute({ eventTitle: 'My Meeting' });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toMatch(/^https:\/\/meet\.example\.com\/my-meeting-[a-f0-9]{8}$/);
    expect(data.url).not.toContain('jwt=');
  });

  it('should include a JWT when JITSI_JWT_SECRET is set', async () => {
    process.env.JITSI_URL = 'https://meet.example.com';
    process.env.JITSI_JWT_SECRET = 'test-secret';
    const response = await callRoute({
      eventTitle: 'Secure Meeting',
      userEmail: 'user@test.com',
      userName: 'Test User',
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toContain('?jwt=');

    // Extract and verify JWT payload
    const jwtParam = new URL(data.url).searchParams.get('jwt');
    expect(jwtParam).toBeTruthy();
    const payload = JSON.parse(atob(jwtParam!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.room).toMatch(/^secure-meeting-[a-f0-9]{8}$/);
    expect(payload.context.user.email).toBe('user@test.com');
    expect(payload.context.user.name).toBe('Test User');
  });

  it('should return 400 for invalid JSON body', async () => {
    process.env.JITSI_URL = 'https://meet.example.com';
    const { POST } = await import('@/app/api/jitsi/route');
    const request = {
      json: async () => { throw new Error('Invalid JSON'); },
    } as never;
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
