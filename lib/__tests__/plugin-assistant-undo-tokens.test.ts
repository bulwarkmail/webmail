import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_TOKEN_TTL_MS, clearUndoTokens, issueUndoToken, withUndoToken } from '../plugin-sandbox/assistant/c.undo';

// The host keeps what an undo needs and hands the plugin only a token: bound
// to that plugin and account, good for 30 minutes, spent once the undo went
// through, kept when it failed.

const use = (token: unknown, { plugin = 'p1', account = 'acc1', kind = 'batch' } = {}, run = async (data: unknown) => data) =>
  withUndoToken('test.undo', plugin, account, kind, token, run);

beforeEach(() => { clearUndoTokens(); });
afterEach(() => { vi.useRealTimers(); });

describe('undo tokens', () => {
  it('work for 30 minutes and not after', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    const early = issueUndoToken('p1', 'acc1', 'batch', 'a');
    const late = issueUndoToken('p1', 'acc1', 'batch', 'b');
    vi.setSystemTime(Date.now() + UNDO_TOKEN_TTL_MS - 1000);
    expect(await use(early)).toBe('a');
    vi.setSystemTime(Date.now() + 2000);
    await expect(use(late)).rejects.toThrow(/can't be undone any more/);
  });

  it('belong to the plugin, the account and the kind they were made for', async () => {
    const token = issueUndoToken('p1', 'acc1', 'batch', 'x');
    await expect(use(token, { account: 'acc2' })).rejects.toThrow(/can't be undone any more/);
    await expect(use(token, { plugin: 'p2' })).rejects.toThrow(/can't be undone any more/);
    await expect(use(token, { kind: 'filters' })).rejects.toThrow(/can't be undone any more/);
    expect(await use(token)).toBe('x');
  });

  it('are spent when the undo went through, and kept when it failed', async () => {
    const token = issueUndoToken('p1', 'acc1', 'batch', 'x');
    await expect(use(token, {}, async () => { throw new Error('server down'); })).rejects.toThrow('server down');
    expect(await use(token)).toBe('x');
    await expect(use(token)).rejects.toThrow(/can't be undone any more/);
  });

  it('run one undo at a time', async () => {
    const token = issueUndoToken('p1', 'acc1', 'batch', 'x');
    let finish!: () => void;
    const first = use(token, {}, () => new Promise((resolve) => { finish = () => resolve('done'); }));
    await expect(use(token)).rejects.toThrow(/can't be undone any more/);
    finish();
    expect(await first).toBe('done');
  });
});
