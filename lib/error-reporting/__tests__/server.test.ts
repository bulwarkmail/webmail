// @vitest-environment node
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

import { captureLoggedError, captureRequestError, installServerErrorReporting } from '../server';
import { flushErrors, readErrors, resetAggregateForTests, utcDay } from '../aggregate';
import { logger, setErrorSink } from '@/lib/logger';

const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';
const SUBJECT = 'Merger plans for Acme Q3';
const ADDRESS = 'ceo.private@acme-corp.example';

let dir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-errors-'));
  process.env.TELEMETRY_DATA_DIR = dir;
  for (const key of Object.keys(config)) delete config[key];
  resetAggregateForTests();
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  setErrorSink(null);
  resetAggregateForTests();
  vi.unstubAllGlobals();
  delete process.env.TELEMETRY_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function serverError(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at handler (/app/.next/server/chunks/77.js:1:900)\n    at /app/node_modules/next/dist/server.js:5:6`;
  return error;
}

describe('server error reporting', () => {
  it('does nothing at all without a DSN or other reason to collect', async () => {
    await captureRequestError(serverError('boom'), '/api/admin/config');
    await flushErrors();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, 'errors.json'))).toBe(false);
  });

  it('sends a request error to the DSN with the route pattern and no mail content', async () => {
    config.errorReportingDsn = DSN;
    config.errorReportingEnvironment = 'beta';
    await captureRequestError(serverError(`Could not file "${SUBJECT}" for ${ADDRESS}`), '/api/wopi/files/[fileId]');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://bugsink.example.org/api/3/envelope/?sentry_key=6f0b9c79ed3a4315b76595bc2536ac40&sentry_version=7');
    const body = String((init as RequestInit).body);
    expect(body).not.toContain('Merger');
    expect(body).not.toContain(ADDRESS);
    const event = JSON.parse(body.trim().split('\n')[2]);
    expect(event.platform).toBe('node');
    expect(event.environment).toBe('beta');
    expect(event.tags).toEqual({ runtime: 'server', route: '/api/wopi/files/[fileId]' });
    expect(event.exception.values[0].stacktrace.frames.at(-1).abs_path).toBe('/.next/server/chunks/77.js');
  });

  it('counts the error per day', async () => {
    config.errorReportingDsn = DSN;
    await captureRequestError(serverError('one'));
    await captureRequestError(serverError('one'));
    await flushErrors();
    const day = (await readErrors())[utcDay()];
    expect(Object.values(day).map((e) => [e.name, e.runtime, e.count])).toEqual([['Error', 'server', 2]]);
  });

  it('reports logger.error calls with the caller\'s frames once installed', async () => {
    config.errorReportingDsn = DSN;
    await installServerErrorReporting();
    logger.error('telemetry GET error', { error: `failed for ${ADDRESS}` });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const event = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body).trim().split('\n')[2]);
    expect(event.exception.values[0].type).toBe('LoggedError');
    expect(event.exception.values[0].value).toBe('telemetry GET error: failed for [email]');
  });

  it('drops the logger\'s own frames from a logged error', async () => {
    config.errorReportingDsn = DSN;
    const stack = 'Error\n    at log (/app/.next/server/chunks/1.js:1:1)\n    at Object.error (/app/.next/server/chunks/1.js:2:2)\n    at GET (/app/.next/server/chunks/route.js:9:9)';
    await captureLoggedError('x failed', undefined, stack);
    const event = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body).trim().split('\n')[2]);
    expect(event.exception.values[0].stacktrace.frames.map((f: { function: string }) => f.function)).toEqual(['GET']);
  });
});
