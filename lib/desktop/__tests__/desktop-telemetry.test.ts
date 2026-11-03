// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCollectorValidator } from '@/lib/__tests__/collector-validator';
import {
  DESKTOP_CATCH_UP_MAX_MS,
  DESKTOP_CATCH_UP_MIN_MS,
  DESKTOP_HEARTBEAT_INTERVAL_MS,
  buildDesktopErrorBatch,
  buildDesktopPing,
  consentInForce,
  desktopBuildTag,
  desktopCatchUpMs,
  desktopChannel,
  desktopOsFamily,
  forcedOffByPolicy,
  heartbeatDelayMs,
} from '../desktop-telemetry';

const collector = await loadCollectorValidator();

const NOT_SET = { value: true, locked: false };
const FORCED_OFF = { value: false, locked: true };
const FORCED_ON = { value: true, locked: true };
const RECOMMENDED_OFF = { value: false, locked: false };

describe('consent', () => {
  it.each([
    [undefined, NOT_SET, false],
    [null, NOT_SET, false],
    [false, NOT_SET, false],
    [true, NOT_SET, true],
    // A policy forcing it off beats the user's yes.
    [true, FORCED_OFF, false],
    // A policy allowing it doesn't answer for the user.
    [undefined, FORCED_ON, false],
    [true, FORCED_ON, true],
    // Only forced counts as forced.
    [true, RECOMMENDED_OFF, true],
    [undefined, RECOMMENDED_OFF, false],
  ])('choice %s under %j is %s', (choice, policy, expected) => {
    expect(consentInForce(choice, policy)).toBe(expected);
  });

  it('knows forced off from the rest', () => {
    expect(forcedOffByPolicy(FORCED_OFF)).toBe(true);
    expect(forcedOffByPolicy(RECOMMENDED_OFF)).toBe(false);
    expect(forcedOffByPolicy(FORCED_ON)).toBe(false);
  });
});

describe('when a heartbeat is due', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const CATCH_UP = 123_000;

  it('soon, with none sent yet or the last one long ago', () => {
    expect(heartbeatDelayMs(undefined, now, CATCH_UP)).toBe(CATCH_UP);
    expect(heartbeatDelayMs(null, now, CATCH_UP)).toBe(CATCH_UP);
    expect(heartbeatDelayMs(now - 3 * DESKTOP_HEARTBEAT_INTERVAL_MS, now, CATCH_UP)).toBe(CATCH_UP);
  });

  it('a day after the last, and not sooner', () => {
    expect(heartbeatDelayMs(now - 3_600_000, now, CATCH_UP)).toBe(DESKTOP_HEARTBEAT_INTERVAL_MS - 3_600_000);
  });

  it('soon again if the clock went back', () => {
    expect(heartbeatDelayMs(now + 3_600_000, now, CATCH_UP)).toBe(CATCH_UP);
  });

  it('soon means somewhere from 30 s to 10 min, so a start time can\'t be read from it', () => {
    expect(desktopCatchUpMs(() => 0)).toBe(30_000);
    expect(desktopCatchUpMs(() => 0.5)).toBe(315_000);
    expect(desktopCatchUpMs(() => 0.999999)).toBeLessThanOrEqual(600_000);
    expect(desktopCatchUpMs(() => 0.999999)).toBeGreaterThan(599_000);
    expect(DESKTOP_CATCH_UP_MIN_MS).toBe(30_000);
    expect(DESKTOP_CATCH_UP_MAX_MS).toBe(600_000);
    const seen = new Set(Array.from({ length: 50 }, () => desktopCatchUpMs()));
    expect(seen.size).toBeGreaterThan(1);
    for (const value of seen) {
      expect(value).toBeGreaterThanOrEqual(30_000);
      expect(value).toBeLessThanOrEqual(600_000);
    }
    expect(heartbeatDelayMs(null, now)).toBeLessThanOrEqual(600_000);
  });
});

describe('the shell\'s own heartbeat', () => {
  const ping = () => buildDesktopPing({
    instanceId: 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b',
    appVersion: '0.3.0-beta.1',
    nodeVersion: '22.11.0',
    osFamily: 'windows',
    mode: 'instance',
    channel: 'beta',
    now: Date.parse('2026-11-03T12:00:00Z'),
  });

  it('claims nothing that is the instance\'s to report', () => {
    const body = ping();
    expect(Object.values(body.features)).toEqual([false, false, false, false, false, false]);
    expect(body.counts).toEqual({ accounts: '0', accounts_active_7d: '0', extensions_installed: 0, themes_installed: 0 });
    expect(body.stalwart_version).toBeNull();
    expect(body.instance_id).toBe('f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b');
  });

  it.skipIf(!collector)('is what the real collector accepts, as schema 1 and as schema 2', () => {
    const clean = collector!.validate(ping())!;
    expect(clean).toMatchObject({ schema: '1', build: 'desktop.instance.beta', version: '0.3.0-beta.1', os_family: 'windows', node_version: '22.11.0' });
    expect(clean.platform).toBe('desktop');
    // Any extra top-level field would make schema 2 refuse the whole heartbeat.
    expect(collector!.validate({ ...ping(), schema: '2', errors: [] })).not.toBeNull();
  });

  it.skipIf(!collector)('main\'s error batch is what the real collector accepts', () => {
    const now = Date.now();
    const batch = buildDesktopErrorBatch('f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', now, [
      { name: 'TypeError', fingerprint: '0123456789abcdef', version: '0.3.0+desktop', count: 7 },
    ]);
    const clean = collector!.validateErrorBatch(batch)!;
    expect(clean).not.toBeNull();
    expect(collector!.validateErrorBatch(buildDesktopErrorBatch('f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', now, [
      { name: 'TypeError', fingerprint: '0123456789abcdef', version: '0.3.0-beta.1+desktop', count: 1 },
    ]))).not.toBeNull();
    expect(clean.errors).toEqual([expect.objectContaining({ name: 'TypeError', count: '6-10', version: '0.3.0+desktop', days: 1, frames: [] })]);
  });

  it('fits the collector\'s pattern for build on every mode and channel', () => {
    for (const mode of ['standalone', 'instance'] as const) {
      for (const channel of ['stable', 'beta'] as const) {
        expect(desktopBuildTag(mode, channel)).toMatch(/^[\w.+-]{1,64}$/);
      }
    }
  });

  it('names the channel: forced, then the user, then the version', () => {
    expect(desktopChannel({ value: 'stable', locked: true }, 'beta', '1.0.0-beta.1')).toBe('stable');
    expect(desktopChannel({ value: 'stable', locked: false }, 'beta', '1.0.0')).toBe('beta');
    expect(desktopChannel({ value: 'stable', locked: false }, undefined, '1.0.0-beta.1')).toBe('beta');
    expect(desktopChannel({ value: 'stable', locked: false }, 'nonsense', '1.0.0')).toBe('stable');
  });

  it('names the OS the way the collector does', () => {
    expect(desktopOsFamily('win32')).toBe('windows');
    expect(desktopOsFamily('darwin')).toBe('darwin');
    expect(desktopOsFamily('linux')).toBe('linux');
    expect(desktopOsFamily('freebsd')).toBe('unknown');
  });

  it('holds no host name, so only one place has the collector', () => {
    const source = readFileSync(path.join(__dirname, '..', 'desktop-telemetry.ts'), 'utf8');
    expect(source).not.toContain('bulwarkmail.org');
  });

  it('the policy says which shell file acts on the two keys', async () => {
    const { POLICY_CONSUMERS } = await import('../policy-schema');
    expect(POLICY_CONSUMERS.TelemetryAllowed).toEqual({ repo: 'shell', file: 'src/main/features/privacy.ts' });
    expect(POLICY_CONSUMERS.CrashReportsAllowed).toEqual({ repo: 'shell', file: 'src/main/features/privacy.ts' });
  });
});
