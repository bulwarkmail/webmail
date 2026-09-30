import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { peekListAttachments, requestListAttachments, type ListAttachmentSource } from '../list-attachments';
import type { Attachment } from '../jmap/types';

type Call = [string, Record<string, unknown>, string];

const pdf = (blobId: string): Attachment => ({ partId: '2', blobId, size: 10, name: `${blobId}.pdf`, type: 'application/pdf' });

function recordingClient(maxObjectsInGet = 50) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'me', capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet } } });
  const gets: Record<string, unknown>[] = [];
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => ({
      methodResponses: calls.map(([method, args, id]) => {
        if (method === 'Email/query') return ['Email/query', { ids: ['m1'], total: 1, position: 0 }, id];
        if (method === 'Email/get') {
          gets.push(args);
          const ids = (args.ids as string[] | undefined) ?? ['m1'];
          return ['Email/get', {
            list: ids.filter(m => m !== 'gone').map(m => ({ id: m, attachments: [pdf(`b-${m}`)] })),
          }, id];
        }
        return [method, {}, id];
      }),
    }));
  return { client, gets };
}

// #1089: asking for `attachments` makes Stalwart read every message's raw
// blob, so a list page must not ask for it.
describe('list requests', () => {
  it('do not ask for attachments but keep blobId for drag-out', async () => {
    const { client, gets } = recordingClient();
    await client.getSomeEmails(['m1']);
    await client.getEmails('inbox');
    expect(gets.length).toBeGreaterThanOrEqual(2);
    for (const args of gets) {
      expect(args.properties).not.toContain('attachments');
      expect(args.properties).toContain('blobId');
      expect(args.properties).toContain('hasAttachment');
    }
  });
});

describe('getEmailAttachments', () => {
  it('asks only for attachment parts, in server-sized batches', async () => {
    const { client, gets } = recordingClient(2);
    const found = await client.getEmailAttachments(['a', 'b', 'c'], 'owner');
    expect(gets.map(g => g.ids)).toEqual([['a', 'b'], ['c']]);
    expect(gets[0]).toMatchObject({ accountId: 'owner', properties: ['id', 'attachments'] });
    expect(gets[0].bodyProperties).toEqual(expect.arrayContaining(['partId', 'blobId', 'name', 'type', 'cid', 'disposition']));
    expect(found.get('c')).toEqual([pdf('b-c')]);
  });

  it('leaves out ids the server did not return', async () => {
    const { client } = recordingClient();
    const found = await client.getEmailAttachments(['a', 'gone']);
    expect([...found.keys()]).toEqual(['a']);
  });
});

describe('requestListAttachments', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function fakeSource(fail = false) {
    const getEmailAttachments = vi.fn(async (ids: string[]) => {
      if (fail) throw new Error('boom');
      return new Map(ids.filter(id => id !== 'gone').map(id => [id, [pdf(id)]]));
    });
    return { getEmailAttachments } satisfies ListAttachmentSource;
  }

  it('coalesces rows that mount together into one request', async () => {
    const source = fakeSource();
    const a = vi.fn(), b = vi.fn();
    requestListAttachments(source, undefined, 'a', a);
    requestListAttachments(source, undefined, 'b', b);
    await vi.runAllTimersAsync();
    expect(source.getEmailAttachments).toHaveBeenCalledTimes(1);
    expect(source.getEmailAttachments).toHaveBeenCalledWith(['a', 'b'], undefined);
    expect(a).toHaveBeenCalledWith([pdf('a')]);
    expect(b).toHaveBeenCalledWith([pdf('b')]);
  });

  it('answers a second mount from the cache, synchronously', async () => {
    const source = fakeSource();
    requestListAttachments(source, undefined, 'a', vi.fn());
    await vi.runAllTimersAsync();
    const again = vi.fn();
    requestListAttachments(source, undefined, 'a', again);
    expect(again).toHaveBeenCalledWith([pdf('a')]);
    expect(source.getEmailAttachments).toHaveBeenCalledTimes(1);
  });

  it('drops a row scrolled away before the request goes out', async () => {
    const source = fakeSource();
    const cancel = requestListAttachments(source, undefined, 'a', vi.fn());
    requestListAttachments(source, undefined, 'b', vi.fn());
    cancel();
    await vi.runAllTimersAsync();
    expect(source.getEmailAttachments).toHaveBeenCalledWith(['b'], undefined);
  });

  it('joins a request already in flight instead of asking again', async () => {
    let release!: () => void;
    const source: ListAttachmentSource & { getEmailAttachments: ReturnType<typeof vi.fn> } = {
      getEmailAttachments: vi.fn(() => new Promise<Map<string, Attachment[]>>((resolve) => {
        release = () => resolve(new Map([['a', [pdf('a')]]]));
      })),
    };
    const first = vi.fn(), second = vi.fn();
    requestListAttachments(source, undefined, 'a', first);
    await vi.advanceTimersByTimeAsync(100);
    requestListAttachments(source, undefined, 'a', second);
    await vi.advanceTimersByTimeAsync(100);
    release();
    await vi.runAllTimersAsync();
    expect(source.getEmailAttachments).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith([pdf('a')]);
  });

  it('keeps accounts apart', async () => {
    const source = fakeSource();
    const own = vi.fn(), shared = vi.fn();
    requestListAttachments(source, undefined, 'a', own);
    requestListAttachments(source, 'owner', 'a', shared);
    await vi.runAllTimersAsync();
    expect(source.getEmailAttachments).toHaveBeenCalledWith(['a'], undefined);
    expect(source.getEmailAttachments).toHaveBeenCalledWith(['a'], 'owner');
  });

  it('does not cache a failure, so the next mount retries', async () => {
    const source = fakeSource(true);
    const onLoad = vi.fn();
    requestListAttachments(source, undefined, 'a', onLoad);
    await vi.runAllTimersAsync();
    expect(onLoad).not.toHaveBeenCalled();
    requestListAttachments(source, undefined, 'a', onLoad);
    await vi.runAllTimersAsync();
    expect(source.getEmailAttachments).toHaveBeenCalledTimes(2);
  });

  it('lets a remounting row peek at the cache without asking', async () => {
    const source = fakeSource();
    expect(peekListAttachments(source, undefined, 'a')).toBeUndefined();
    requestListAttachments(source, undefined, 'a', vi.fn());
    await vi.runAllTimersAsync();
    expect(peekListAttachments(source, undefined, 'a')).toEqual([pdf('a')]);
    expect(peekListAttachments(source, 'owner', 'a')).toBeUndefined();
    expect(source.getEmailAttachments).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a client without lazy attachments', () => {
    const onLoad = vi.fn();
    const cancel = requestListAttachments({}, undefined, 'a', onLoad);
    cancel();
    expect(onLoad).not.toHaveBeenCalled();
  });
});
