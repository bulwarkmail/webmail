import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerError = vi.fn();

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number; headers?: unknown }) => ({
      status: init?.status ?? 200,
      headers: init?.headers,
      json: async () => data,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: loggerError,
  },
}));

describe('health route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loggerError.mockReset();
  });

  it('returns healthy for the basic liveness probe even when heap usage is high', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 120_000_000,
      heapTotal: 45_000_000,
      heapUsed: 43_000_000,
      external: 8_000_000,
      arrayBuffers: 1_000_000,
    });

    const { GET } = await import('@/app/api/health/route');
    const response = await GET({ nextUrl: new URL('http://localhost/api/health') } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'healthy',
    });
    expect(payload.warnings).toBeUndefined();
  });

  it('returns degraded diagnostics in detailed mode without failing the probe', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 120_000_000,
      heapTotal: 4_100_000_000,
      heapUsed: 4_000_000_000,
      external: 8_000_000,
      arrayBuffers: 1_000_000,
    });
    vi.spyOn(process, 'uptime').mockReturnValue(123.45);

    const { GET } = await import('@/app/api/health/route');
    const response = await GET({ nextUrl: new URL('http://localhost/api/health?detailed=true') } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe('degraded');
    expect(payload.memory).toMatchObject({
      heapUsed: 4_000_000_000,
      heapTotal: 4_100_000_000,
      rss: 120_000_000,
      external: 8_000_000,
    });
    expect(payload.memory.heapSizeLimit).toBeGreaterThan(0);
    expect(payload.warnings).toEqual([
      expect.stringContaining('V8 heap usage is high'),
    ]);
  });

  it('keeps HEAD as a stable liveness probe', async () => {
    const { HEAD } = await import('@/app/api/health/route');
    const response = await HEAD();

    expect(response.status).toBe(200);
  });

  it('returns 503 when collecting health diagnostics throws', async () => {
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('boom');
    });

    const { GET } = await import('@/app/api/health/route');
    const response = await GET({ nextUrl: new URL('http://localhost/api/health') } as never);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      status: 'unhealthy',
      reason: 'boom',
    });
    expect(loggerError).toHaveBeenCalledWith('Health check failed', { error: 'boom' });
  });
});