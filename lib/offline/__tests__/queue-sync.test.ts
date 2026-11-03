import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queuePatch, queueSend } from '../queue';

// Whatever goes into the queue asks for a Background Sync, once it's stored.

const requestOutboxSync = vi.fn();
const stored: unknown[] = [];
vi.mock('@/lib/pwa-notify/outbox-sync', () => ({ requestOutboxSync: () => requestOutboxSync(stored.length) }));
vi.mock('../db', () => ({
  idbAdd: vi.fn(async (_store: string, record: unknown) => { stored.push(record); return stored.length; }),
  idbDeleteAccount: vi.fn(), idbGet: vi.fn(), idbGetAll: vi.fn(), idbGetAllByAccount: vi.fn(), idbUpdate: vi.fn(), idbWrite: vi.fn(),
}));
vi.mock('../crypto', () => ({
  sealJson: vi.fn(async () => ({ iv: 'i', data: 'd' })),
  openJson: vi.fn(), openBytes: vi.fn(), sealBytes: vi.fn(),
}));

beforeEach(() => {
  stored.length = 0;
  requestOutboxSync.mockClear();
});

describe('the offline queue', () => {
  it('asks for a sync after storing a change', async () => {
    await queuePatch('acc', 'jmap', {} as never);
    expect(requestOutboxSync).toHaveBeenCalledTimes(1);
    expect(requestOutboxSync).toHaveBeenCalledWith(1);
  });

  it('asks for a sync after storing a message, and still returns its id', async () => {
    const id = await queueSend('acc', {} as never, {} as never);
    expect(id).toBe(1);
    expect(requestOutboxSync).toHaveBeenCalledWith(1);
  });
});
