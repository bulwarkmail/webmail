type Call = [string, Record<string, unknown>, string];
type Response = { methodResponses: Array<[string, Record<string, unknown>, string]> };

/** Keep the usual one-call path; recover when the folder tree exceeds /get limits. */
export async function getMailboxResponse(
  request: (calls: Call[]) => Promise<Response>, accountId: string, maxObjects: number,
): Promise<Response> {
  const first = await request([['Mailbox/get', { accountId }, '0']]);
  const initial = first.methodResponses[0];
  if (initial?.[0] !== 'error' || initial[1].type !== 'requestTooLarge') return first;

  const limit = Math.max(1, Math.min(100, maxObjects));
  const list: unknown[] = [];
  const seen = new Set<string>();
  let position = 0;
  let queryState: unknown;
  let state: unknown;
  for (let page = 0; page < 1000; page++) {
    const query = (await request([['Mailbox/query', { accountId, position, limit }, 'q']])).methodResponses[0];
    if (query?.[0] !== 'Mailbox/query' || !Array.isArray(query[1].ids)) throw new Error('Cannot list mailboxes');
    if (page && query[1].queryState !== queryState) throw new Error('Mailbox list changed while loading; refresh to retry');
    queryState = query[1].queryState;
    const ids = query[1].ids as string[];
    if (ids.some(id => typeof id !== 'string' || seen.has(id)) || new Set(ids).size !== ids.length) throw new Error('Mailbox query did not advance');
    if (ids.length > limit) throw new Error('Mailbox query exceeded requested limit');
    if (!ids.length) {
      if (state === undefined) return request([['Mailbox/get', { accountId, ids: [] }, '0']]);
      return { methodResponses: [['Mailbox/get', { accountId, state, list, notFound: [] }, '0']] };
    }
    ids.forEach(id => seen.add(id));
    const got = (await request([['Mailbox/get', { accountId, ids }, 'g']])).methodResponses[0];
    if (got?.[0] !== 'Mailbox/get' || !Array.isArray(got[1].list)) throw new Error('Cannot fetch mailboxes');
    if (page && got[1].state !== state) throw new Error('Mailboxes changed while loading; refresh to retry');
    if (Array.isArray(got[1].notFound) && got[1].notFound.length) throw new Error('Mailbox disappeared while loading');
    state = got[1].state;
    list.push(...got[1].list);
    position += ids.length;
  }
  throw new Error('Mailbox pagination limit exceeded');
}
