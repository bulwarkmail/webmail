// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A telemetry state file that couldn't be read (a torn write, a passing I/O
// error) used to be replaced with the defaults, which turned the admin's
// consent off for good. Now the read answers with the defaults and leaves
// the file alone.

vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-telemetry-state-'));
  vi.stubEnv('TELEMETRY_DATA_DIR', dir);
  vi.stubEnv('BULWARK_TELEMETRY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('telemetry state that cannot be read', () => {
  it('keeps the stored consent', async () => {
    const { effectiveConsent, loadState } = await import('@/lib/telemetry/state');
    const good = JSON.stringify({ consent: 'on', endpoint: 'https://collector.example.org/', consentedAt: '2026-10-01T00:00:00.000Z', lastSentAt: null, nextScheduledAt: null });
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    writeFileSync(file, good.slice(0, 20));

    expect((await loadState()).consent).toBe('off');
    expect((await effectiveConsent()).consent).toBe('off');
    expect(readFileSync(file, 'utf8')).toBe(good.slice(0, 20));

    writeFileSync(file, good);
    expect((await effectiveConsent()).consent).toBe('on');
  });

  it('refuses to write over it', async () => {
    const { updateState } = await import('@/lib/telemetry/state');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    writeFileSync(file, '{"consent":"on","endp');

    await expect(updateState((state) => { state.nextScheduledAt = 'x'; })).rejects.toThrow('could not be read');
    expect(readFileSync(file, 'utf8')).toBe('{"consent":"on","endp');
  });

  it('still writes the default state on a fresh install', async () => {
    const { loadState } = await import('@/lib/telemetry/state');
    expect((await loadState()).consent).toBe('off');
    expect(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).consent).toBe('off');
  });
});
