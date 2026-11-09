/**
 * x:ArchivedItem answers for the tests. DERIVED, NOT RECORDED: no test server
 * has an Enterprise license, so these are built from the Stalwart source
 * (0.16.23 and the 1.0 checkout, identical here):
 * - the object: crates/registry/src/schema/structs_impl.rs, `impl IntoValue
 *   for ArchivedEmail` (from, subject, receivedAt, size, accountId,
 *   archivedAt, archivedUntil, blobId) inside `ArchivedItem`, tagged `@type`;
 *   files, events, contacts and scripts are archived too. Dates are
 *   UTCDateTime's Display ("2026-10-20T08:00:00Z");
 * - `from` as the archiving code builds it (1.0
 *   crates/services/src/index_queue/index.rs, 0.16
 *   crates/services/src/task_manager/index.rs): "Name <address>", the
 *   address, or the name. `receivedAt` is the Date header, or the deletion
 *   time without one, on 1.0, and the received time on 0.16;
 * - the query (fakeArchiveServer below): crates/jmap/src/registry/query.rs
 *   `extract_parameters` and crates/jmap/src/api/query.rs
 *   `QueryResponseBuilder`. Descending by id by default. Without
 *   `calculateTotal` the store scans ascending, cut at `limit` or 5000 from
 *   `position`, then the ids are reversed and `position` is applied again;
 *   with it everything is scanned and sorted, and position and limit page
 *   it. A user without Impersonate is refused an `accountId` filter
 *   (`unsupportedFilter`);
 * - /get for a user without Impersonate: only the items of the call's
 *   account, each without `accountId` (crates/jmap/src/registry/get.rs
 *   `insert`, 1.0.1; #1480);
 * - the /set answer: crates/jmap/src/registry/mapping/archived_item.rs
 *   (`updated` with null, `notUpdated` with `notFound`).
 * The `forbidden` refusal is the one the unlicensed test servers really
 * send (local-data/org-features-facts.md §3).
 */

export const ACCOUNT = 'ci';

export const LICENSE_REFUSAL = {
  type: 'forbidden',
  description: 'This feature is only available in the Enterprise edition. Obtain your trial license at https://license.stalw.art/trial.',
};

export function archivedEmail(id: string, fields: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    '@type': 'Email',
    from: 'Org Bob <org-bob@example.org>',
    subject: `Message ${id}`,
    receivedAt: '2026-10-01T09:00:00Z',
    size: 2048,
    accountId: ACCOUNT,
    archivedAt: '2026-10-20T08:00:00Z',
    archivedUntil: '2026-11-19T08:00:00Z',
    blobId: `blob-${id}`,
    ...fields,
  };
}

export const ARCHIVED_FILE = {
  id: 'f1',
  '@type': 'FileNode',
  name: 'plan.pdf',
  createdAt: '2026-10-01T09:00:00Z',
  accountId: ACCOUNT,
  archivedAt: '2026-10-21T08:00:00Z',
  archivedUntil: '2026-11-20T08:00:00Z',
  blobId: 'blob-f1',
};

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * `count` archived items, item n deleted n minutes before `now` (so a
 * higher n is older); every fifth is a file, the rest messages. Ids sort
 * like Stalwart's registry ids: the newest has the highest id.
 */
export function bigArchive(count: number, now: number, accountId = ACCOUNT): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let n = 0; n < count; n++) {
    const id = `i${String(count - n).padStart(6, '0')}`;
    const archivedAt = iso(now - n * 60_000);
    out.push(n % 5 === 4
      ? { ...ARCHIVED_FILE, id, accountId, archivedAt, archivedUntil: iso(now + 86_400_000) }
      : archivedEmail(id, { accountId, archivedAt, archivedUntil: iso(now + 86_400_000), subject: `Message ${n}` }));
  }
  return out;
}

type Call = [string, Record<string, unknown>, string];

/**
 * A stand-in for Stalwart's x:ArchivedItem methods over `items` (any
 * accounts), answering one JMAP request body. `impersonate` gives the
 * admin's view: every account, and the `accountId` filter accepted.
 */
export function fakeArchiveServer(items: Array<Record<string, unknown>>, options: { impersonate?: boolean; maxResults?: number } = {}) {
  const maxResults = options.maxResults ?? 5000;
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const calls: Call[] = [];
  const answer = (body: { methodCalls: Call[] }) => ({
    methodResponses: body.methodCalls.map(([method, args, callId]): Call => {
      calls.push([method, args, callId]);
      const account = args.accountId as string;
      if (method === 'x:ArchivedItem/query') {
        const filter = args.filter as { accountId?: string } | undefined;
        if (filter?.accountId && !options.impersonate) return ['error', { type: 'unsupportedFilter', description: 'Filter on property accountId is not supported or invalid' }, callId];
        const owner = filter?.accountId ?? (options.impersonate ? null : account);
        const ascending = [...byId.values()].filter((i) => owner === null || i.accountId === owner).map((i) => i.id as string).sort();
        const position = (args.position as number | undefined) ?? 0;
        const limit = Math.min((args.limit as number | undefined) ?? maxResults, maxResults);
        let ids: string[];
        if (args.calculateTotal) {
          ids = [...ascending].reverse().slice(position, position + limit);
        } else {
          // The store cuts the ascending scan, then the ids are reversed and position applied again.
          const scanned = ascending.slice(position, position + limit).reverse();
          ids = scanned.slice(position, position + limit);
        }
        return [method, { accountId: account, ids, position, ...(args.calculateTotal ? { total: ascending.length } : {}), queryState: 's0', canCalculateChanges: true }, callId];
      }
      if (method === 'x:ArchivedItem/get') {
        const ids = args.ids as string[];
        const visible = ids.map((i) => byId.get(i)).filter((i): i is Record<string, unknown> => !!i && (!!options.impersonate || i.accountId === account));
        // Without Impersonate the server leaves accountId out of every item (registry/get.rs `insert`).
        const list = options.impersonate ? visible : visible.map(({ accountId: _owner, ...rest }) => rest);
        return [method, { accountId: account, list, notFound: ids.filter((i) => !visible.some((v) => v.id === i)) }, callId];
      }
      if (method === 'x:ArchivedItem/set') {
        const ids = Object.keys(args.update as object);
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        for (const i of ids) {
          if (byId.has(i)) { updated[i] = null; byId.delete(i); } else notUpdated[i] = { type: 'notFound' };
        }
        return [method, { accountId: account, updated, notUpdated }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    }),
  });
  return { answer, calls, remaining: () => [...byId.keys()] };
}
