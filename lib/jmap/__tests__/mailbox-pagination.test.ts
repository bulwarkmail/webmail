import { expect, it, vi } from 'vitest';
import { getMailboxResponse } from '../mailbox-pagination';
const response = (method: string, data: Record<string, unknown>) => ({ methodResponses: [[method, data, '0'] as [string, Record<string, unknown>, string]] });
it('keeps the single request path and does not retry unrelated failures', async () => {
  for (const r of [response('Mailbox/get', { list: [], state: 's' }), response('error', { type: 'accountNotFound' })]) {
    const request = vi.fn(async () => r);
    expect(await getMailboxResponse(request, 'a', 100)).toBe(r);
    expect(request).toHaveBeenCalledTimes(1);
  }
});
it('loads 128 folders despite a server clamping query pages below the requested limit', async () => {
  const boxes = Array.from({ length: 128 }, (_, n) => ({ id: `m${n}`, parentId: n ? 'm0' : null }));
  const request = vi.fn(async (calls: [string, Record<string, unknown>, string][]) => {
    const [method, args] = calls[0];
    if (method === 'Mailbox/query') return response(method, { ids: boxes.slice(Number(args.position), Number(args.position) + 40).map(b => b.id), queryState: 'q' });
    if (!args.ids) return response('error', { type: 'requestTooLarge' });
    expect((args.ids as string[]).length).toBeLessThanOrEqual(100);
    return response(method, { list: boxes.filter(b => (args.ids as string[]).includes(b.id)), state: 's', notFound: [] });
  });
  const r = await getMailboxResponse(request, 'a', 100);
  expect(r.methodResponses[0][1]).toMatchObject({ list: boxes, state: 's' });
});
it.each(['changed', 'repeated', 'getFailure'])('rejects partial results when %s occurs', async mode => {
  let page = 0;
  const request = vi.fn(async (calls: [string, Record<string, unknown>, string][]) => {
    const [method, args] = calls[0];
    if (method === 'Mailbox/query') return response(method, { ids: [mode === 'repeated' ? 'm' : `m${page++}`], queryState: 'q' });
    if (!args.ids) return response('error', { type: 'requestTooLarge' });
    if (mode === 'getFailure') return response('error', { type: 'serverFail' });
    return response(method, { list: [{ id: (args.ids as string[])[0] }], state: mode === 'changed' ? String(page) : 's' });
  });
  await expect(getMailboxResponse(request, 'a', 100)).rejects.toThrow();
});
