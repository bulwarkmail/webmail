// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { buildEnvelope, buildEvent, envelopeUrl, isErrorCode, parseDsn } from '../envelope';
import { debugIdsByPath, resetDebugIdCache } from '../debug-ids';
import { fingerprint } from '../fingerprint';
import { parseStack } from '../stack';

const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@bugsink.example.org/3';

describe('parseDsn', () => {
  it('reads key, origin and project', () => {
    expect(parseDsn(DSN)).toEqual({ origin: 'https://bugsink.example.org', pathPrefix: '', publicKey: '6f0b9c79ed3a4315b76595bc2536ac40', projectId: '3' });
    expect(parseDsn('https://6f0b9c79ed3a4315b76595bc2536ac40@host.example:8443/sentry/12')?.pathPrefix).toBe('/sentry');
  });

  it('refuses what is not a DSN', () => {
    for (const bad of ['', 'not a url', 'https://bugsink.example.org/3', 'ftp://6f0b9c79ed3a4315b76595bc2536ac40@x.example/3',
      'https://6f0b9c79ed3a4315b76595bc2536ac40@x.example/abc', 'https://6f0b9c79ed3a4315b76595bc2536ac40:secret@x.example/3']) {
      expect(parseDsn(bad), bad).toBeNull();
    }
  });

  it('puts the key in the query, so a browser sends no custom header', () => {
    expect(envelopeUrl(parseDsn(DSN)!)).toBe('https://bugsink.example.org/api/3/envelope/?sentry_key=6f0b9c79ed3a4315b76595bc2536ac40&sentry_version=7');
  });
});

describe('stack parsing', () => {
  it('reads V8, Firefox and Safari stacks, top frame first', () => {
    const chrome = 'TypeError: x\n    at Ab (https://mail.example.org/_next/static/chunks/1.js:2:30)\n    at async https://mail.example.org/_next/static/chunks/2.js:4:5';
    const firefox = 'Ab@https://mail.example.org/_next/static/chunks/1.js:2:30\n@https://mail.example.org/_next/static/chunks/2.js:4:5';
    for (const stack of [chrome, firefox]) {
      expect(parseStack(stack)).toEqual([
        { path: '/_next/static/chunks/1.js', line: 2, column: 30, fn: 'Ab' },
        { path: '/_next/static/chunks/2.js', line: 4, column: 5, fn: undefined },
      ]);
    }
    expect(parseStack('    at Object.handler (/app/.next/server/chunks/77.js:1:900)')[0]).toEqual({ path: '/.next/server/chunks/77.js', line: 1, column: 900, fn: 'Object.handler' });
  });
});

describe('debug ids', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)._debugIds;
    delete (globalThis as Record<string, unknown>)._sentryDebugIds;
    resetDebugIdCache();
  });

  it('maps each registered chunk to its id, from Turbopack and sentry-cli alike', () => {
    (globalThis as Record<string, unknown>)._debugIds = {
      'Error\n    at https://mail.example.org/_next/static/chunks/1.js:1:10': 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2',
    };
    (globalThis as Record<string, unknown>)._sentryDebugIds = {
      'Error\n    at https://mail.example.org/_next/static/chunks/2.js:1:10': 'c40c4654-00a8-5efe-b3a3-42818d0ccc15',
    };
    expect(Object.fromEntries(debugIdsByPath())).toEqual({
      '/_next/static/chunks/1.js': 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2',
      '/_next/static/chunks/2.js': 'c40c4654-00a8-5efe-b3a3-42818d0ccc15',
    });
  });
});

describe('buildEvent', () => {
  const frames = [
    { path: '/_next/static/chunks/1.js', line: 2, column: 30, fn: 'Ab' },
    { path: '/_next/static/chunks/2.js', line: 4, column: 5 },
  ];
  const event = buildEvent(
    { name: 'TypeError', message: 'x is undefined', frames, handled: false, mechanism: 'onerror', route: '/mail/…' },
    {
      eventId: 'a'.repeat(32), timestamp: 1, release: '1.20.0+abc1234', environment: 'production', platform: 'javascript',
      fingerprint: 'ffff0000ffff0000', debugIds: new Map([['/_next/static/chunks/1.js', 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2']]),
    },
  );

  it('names a source map image for each frame file with a debug id, under the frame path', () => {
    const exception = (event.exception as { values: Array<{ stacktrace: { frames: Array<{ abs_path: string; lineno: number }> } }> }).values[0];
    // Oldest first: the throwing frame is last.
    expect(exception.stacktrace.frames.map((f) => f.abs_path)).toEqual(['/_next/static/chunks/2.js', '/_next/static/chunks/1.js']);
    expect(event.debug_meta).toEqual({ images: [{ type: 'sourcemap', code_file: '/_next/static/chunks/1.js', debug_id: 'bc67f7db-7f3b-7be2-6f94-966cd7825cc2' }] });
  });

  it('groups by Bulwark\'s fingerprint and carries the release', () => {
    expect(event.fingerprint).toEqual(['ffff0000ffff0000']);
    expect(event.release).toBe('1.20.0+abc1234');
    expect(event.tags).toEqual({ route: '/mail/…' });
  });

  it('wraps it in a three-line envelope', () => {
    const lines = buildEnvelope(event).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toEqual({ type: 'event', content_type: 'application/json' });
    expect(JSON.parse(lines[2]).event_id).toBe('a'.repeat(32));
  });
});

describe('fingerprint', () => {
  const frames = [{ path: '/_next/static/chunks/1.js', line: 2, column: 30 }];

  it('differs by name, frame, version and code, and ignores frames outside the bundle', () => {
    const base = fingerprint('TypeError', frames, '1.20.0');
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint('TypeError', frames, '1.20.0')).toBe(base);
    expect(fingerprint('RangeError', frames, '1.20.0')).not.toBe(base);
    expect(fingerprint('TypeError', [{ ...frames[0], line: 3 }], '1.20.0')).not.toBe(base);
    expect(fingerprint('TypeError', frames, '1.20.1')).not.toBe(base);
    expect(fingerprint('TypeError', frames, '1.20.0', 'serverFail')).not.toBe(base);
    expect(fingerprint('TypeError', [...frames, { path: '[other]', line: 1, column: 1 }], '1.20.0')).toBe(base);
  });

  it('accepts only fixed error codes', () => {
    expect(isErrorCode('Email/set: overQuota')).toBe(true);
    expect(isErrorCode('serverFail')).toBe(true);
    expect(isErrorCode('http:503')).toBe(true);
    expect(isErrorCode('Merger plans for Acme')).toBe(false);
    expect(isErrorCode('Email/set: over quota now')).toBe(false);
  });
});
