import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { RateLimitError } from '../client';
import { retryAfterMinutes, retryAfterMs, uploadRateLimit, uploadRefusedError } from '../upload-errors';
import { fileErrorKind } from '@/lib/file-errors';
import { jmapSetError } from '../jmap-error';
import { useUploadRateLimitText } from '@/hooks/use-upload-rate-limit-text';
import { UploadXHR, uploadClient } from '@/lib/__tests__/helpers/upload-xhr';

// #1782: an upload refused with HTTP 429 says there were too many uploads,
// and when to try again if the server said so in Retry-After.

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
}));

const NOW = Date.parse('2026-11-20T12:00:00Z');
const file = () => new File(['0123456789'], 'A.txt', { type: 'text/plain' });

describe('retryAfterMs', () => {
  it('reads delay-seconds and an HTTP date', () => {
    expect(retryAfterMs('1505', NOW)).toBe(1_505_000);
    expect(retryAfterMs('Fri, 20 Nov 2026 12:25:00 GMT', NOW)).toBe(25 * 60_000);
  });

  it('is undefined without a readable value, and never negative', () => {
    expect(retryAfterMs(null, NOW)).toBeUndefined();
    expect(retryAfterMs('', NOW)).toBeUndefined();
    expect(retryAfterMs('soon', NOW)).toBeUndefined();
    expect(retryAfterMs('Fri, 20 Nov 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it('rounds up to whole minutes, at least one', () => {
    expect(retryAfterMinutes(1_505_000)).toBe(26);
    expect(retryAfterMinutes(0)).toBe(1);
  });
});

describe('uploadRateLimit', () => {
  it('tells a 429 from other refusals', () => {
    expect(uploadRateLimit(uploadRefusedError(429, '', '60'))).toEqual({ retryAfterMs: 60_000 });
    expect(uploadRateLimit(uploadRefusedError(429, '', null))).toEqual({});
    expect(uploadRateLimit(uploadRefusedError(413, 'too large', '60'))).toBeNull();
    expect(uploadRateLimit(new Error('Failed to upload file: 429 - quota'))).toEqual({});
    expect(uploadRateLimit(new RateLimitError(60_000))).toBeNull();
    expect(uploadRateLimit('Failed to upload file: 429')).toBeNull();
  });

  it('is a Files error kind of its own', () => {
    expect(fileErrorKind(uploadRefusedError(429, '', '60'))).toBe('rateLimited');
    expect(fileErrorKind(jmapSetError('Too many files.', { type: 'overQuota' }))).toBe('overQuota');
  });
});

describe('useUploadRateLimitText', () => {
  it('says when to try again, or later when the server did not say', () => {
    const { result } = renderHook(() => useUploadRateLimitText());
    expect(result.current(uploadRefusedError(429, '', '1505'))).toBe('upload_rate_limit.retry_in {"minutes":26}');
    expect(result.current(uploadRefusedError(429, '', null))).toBe('upload_rate_limit.retry_later');
    expect(result.current(uploadRefusedError(500, 'oops'))).toBeUndefined();
  });
});

describe('JMAPClient.uploadBlob refused with 429', () => {
  beforeEach(() => {
    UploadXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', UploadXHR);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps Retry-After on the XHR path, with the message the mail import reads', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); }));
    const client = uploadClient();
    const upload = client.uploadBlob(file(), { onProgress: vi.fn() }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(UploadXHR.instances).toHaveLength(1));
    UploadXHR.instances[0].load(429, 'You have exceeded the blob upload quota', { 'Retry-After': '1505' });
    const error = await upload;
    expect((error as Error).message).toBe('Failed to upload file: 429 - You have exceeded the blob upload quota');
    expect(uploadRateLimit(error)).toEqual({ retryAfterMs: 1_505_000 });
  });

  it('keeps Retry-After on the fetch path, still as a RateLimitError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '1505' } })));
    const client = uploadClient();
    const error = await client.uploadBlob(file()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(uploadRateLimit(error)).toEqual({ retryAfterMs: 1_505_000 });
  });

  it('says nothing about minutes when the browser cannot read Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const client = uploadClient();
    const error = await client.uploadBlob(file()).catch((e: unknown) => e);
    expect(uploadRateLimit(error)).toEqual({});
  });
});
