import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthMetadata } from '../oauth/discovery';

// Capture status/headers from NextResponse.json (the shared config-route mock
// drops them, but this route's behavior depends on the status code).
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      json: async () => data,
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn().mockResolvedValue(undefined), get: (_key: string, fallback: unknown) => fallback },
}));

const discoverSignIn = vi.fn();
const getRequiredConfig = vi.fn();
vi.mock('@/lib/oauth/token-exchange', () => ({
  discoverSignIn: (...args: unknown[]) => discoverSignIn(...args),
  getRequiredConfig: (...args: unknown[]) => getRequiredConfig(...args),
}));

const VALID_METADATA: OAuthMetadata = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
};

function mockRequest(serverId?: string): unknown {
  return {
    nextUrl: {
      searchParams: { get: (k: string) => (k === 'server_id' ? serverId ?? null : null) },
    },
  };
}

async function callRoute(serverId?: string) {
  const { GET } = await import('@/app/api/auth/oauth/metadata/route');
  const res = (await GET(mockRequest(serverId) as Parameters<typeof GET>[0])) as unknown as {
    status: number;
    headers: Record<string, string>;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, headers: res.headers, body: await res.json() };
}

describe('oauth metadata route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRequiredConfig.mockReturnValue({ discoveryUrl: 'https://auth.example.com' });
  });

  it('returns discovered metadata for the resolved server', async () => {
    discoverSignIn.mockResolvedValue({ metadata: VALID_METADATA });

    const { status, body, headers } = await callRoute('server-1');

    expect(status).toBe(200);
    expect(body).toEqual(VALID_METADATA);
    expect(headers['Cache-Control']).toContain('max-age=600');
    // Discovery as for a sign-in, with its issuer rule.
    expect(discoverSignIn).toHaveBeenCalledWith('server-1');
  });

  it('says when the provider names another issuer than a sign-in may take', async () => {
    discoverSignIn.mockResolvedValue({ metadata: null, refusal: 'issuer_mismatch' });

    const { status, body } = await callRoute('server-1');

    expect(status).toBe(502);
    expect(body).toEqual({ error: 'issuer_mismatch' });
  });

  it('returns 404 when OAuth is not configured', async () => {
    getRequiredConfig.mockImplementation(() => {
      throw new Error('OAuth misconfigured: OAUTH_CLIENT_ID not set');
    });

    const { status, body } = await callRoute();

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'OAuth not configured' });
    expect(discoverSignIn).not.toHaveBeenCalled();
  });

  it('returns 502 when discovery yields no usable endpoints', async () => {
    discoverSignIn.mockResolvedValue({ metadata: null, refusal: 'unavailable' });

    const { status, body } = await callRoute();

    expect(status).toBe(502);
    expect(body).toEqual({ error: 'OAuth discovery failed' });
  });

  it('returns 502 when discovery throws', async () => {
    discoverSignIn.mockRejectedValue(new Error('network down'));

    const { status, body } = await callRoute();

    expect(status).toBe(502);
    expect(body).toEqual({ error: 'OAuth discovery failed' });
  });
});
