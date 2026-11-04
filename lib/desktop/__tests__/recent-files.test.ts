import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY_SNAPSHOT, type PolicySnapshot } from '../policy-schema';
import type { BulwarkDesktopBridge, DesktopRecentFilesBridge } from '../types';
import { listRecentFiles, readRecentFile, recentFilesOffered, recentWhen } from '../recent-files';

function setBridge(recentFiles?: Partial<DesktopRecentFilesBridge>, policy: Partial<PolicySnapshot> = {}) {
  const snapshot = { ...DEFAULT_POLICY_SNAPSHOT, ...policy };
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    policy: { get: () => snapshot, onChange: () => () => {} },
    ...(recentFiles ? { recentFiles: recentFiles as DesktopRecentFilesBridge } : {}),
  } as BulwarkDesktopBridge;
}

const off = { RecentFilesInAttach: { value: false, source: 'forced-machine', locked: true } } as Partial<PolicySnapshot>;

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('whether the Attach menu lists recent files', () => {
  it('not in a browser, not under a shell without the list, not when the policy says no', () => {
    expect(recentFilesOffered()).toBe(false);
    setBridge();
    expect(recentFilesOffered()).toBe(false);
    setBridge({ list: vi.fn(), attach: vi.fn() });
    expect(recentFilesOffered()).toBe(true);
    setBridge({ list: vi.fn(), attach: vi.fn() }, off);
    expect(recentFilesOffered()).toBe(false);
  });
});

describe('listRecentFiles', () => {
  it('gives the files, and nothing when main says no or fails', async () => {
    const file = { id: 'a', name: 'a.pdf', folder: 'C:\\Docs', path: 'C:\\Docs\\a.pdf', usedAt: 1 };
    setBridge({ list: vi.fn(async () => ({ ok: true as const, files: [file] })) });
    expect(await listRecentFiles()).toEqual([file]);
    setBridge({ list: vi.fn(async () => ({ ok: false as const, reason: 'gesture' as const })) });
    expect(await listRecentFiles()).toEqual([]);
    setBridge({ list: vi.fn(async () => { throw new Error('gone'); }) });
    expect(await listRecentFiles()).toEqual([]);
    window.bulwarkDesktop = undefined;
    expect(await listRecentFiles()).toEqual([]);
  });
});

describe('readRecentFile', () => {
  it('turns the bytes into a File with the name main gave', async () => {
    const attach = vi.fn(async () => ({ ok: true as const, file: { name: 'Report.docx', data: new TextEncoder().encode('hello') } }));
    setBridge({ attach });
    const result = await readRecentFile('id-1');
    expect(attach).toHaveBeenCalledWith('id-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.name).toBe('Report.docx');
    expect(await result.file.text()).toBe('hello');
  });

  it('says what the user can act on, and keeps quiet about a lock or a policy', async () => {
    const answer = (reason: string) => {
      setBridge({ attach: vi.fn(async () => ({ ok: false, reason }) as never) });
      return readRecentFile('x');
    };
    expect(await answer('missing')).toEqual({ ok: false, reason: 'missing' });
    expect(await answer('too-large')).toEqual({ ok: false, reason: 'too-large' });
    expect(await answer('unknown')).toEqual({ ok: false, reason: 'failed' });
    expect(await answer('gesture')).toEqual({ ok: false, reason: 'failed' });
    expect(await answer('locked')).toEqual({ ok: false, reason: 'quiet' });
    expect(await answer('policy')).toEqual({ ok: false, reason: 'quiet' });
  });
});

describe('recentWhen', () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  it('counts minutes and hours today, calendar days this week, then weeks and months', () => {
    expect(recentWhen(now - 20_000, now, 'en')).toBe('now');
    expect(recentWhen(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago');
    expect(recentWhen(now - 3 * 60 * 60_000, now, 'en')).toBe('3 hours ago');
    // Last night at 23:00, 16 hours ago: yesterday.
    expect(recentWhen(new Date(2026, 10, 3, 23, 0).getTime(), now, 'en')).toBe('yesterday');
    expect(recentWhen(new Date(2026, 10, 1, 9, 0).getTime(), now, 'en')).toBe('3 days ago');
    expect(recentWhen(now - 15 * 24 * 60 * 60_000, now, 'en')).toBe('2 weeks ago');
    expect(recentWhen(now - 70 * 24 * 60 * 60_000, now, 'en')).toBe('2 months ago');
    expect(recentWhen(now - 3 * 60 * 60_000, now, 'de')).toBe('vor 3 Stunden');
  });
});
