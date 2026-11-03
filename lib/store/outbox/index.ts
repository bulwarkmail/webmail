import type { RecordOverlay, StoreArea } from '../area';
import { DRAFT_CALLS } from '../drafts/calls';
import { draftsOverlay } from '../drafts/pending';
import { DRAFT_MIGRATIONS } from '../drafts/schema';
import { OUTBOX_CALLS } from './calls';
import { emailSet, outboxOverlay } from './email-set';
import { OUTBOX_MIGRATIONS } from './schema';

const overlay: RecordOverlay = (ctx, jmap, type, records) => draftsOverlay(ctx, jmap, type, outboxOverlay(ctx, jmap, type, records));

/** Drafts answer the same Email/set and share the queue's order, so they plug in here. */
export const outboxArea: StoreArea = {
  name: 'outbox',
  migrations: [...OUTBOX_MIGRATIONS, ...DRAFT_MIGRATIONS],
  methods: { 'Email/set': emailSet },
  syncers: [],
  calls: { ...OUTBOX_CALLS, ...DRAFT_CALLS },
  overlay,
  // A draft only on this device has no other copy, however old it is.
  spares: (ctx, jmap, type) => (type === 'Email'
    ? ctx.db.all<{ local_id: string }>('SELECT local_id FROM draft_pending WHERE jmap = ?', [jmap]).map((row) => row.local_id)
    : []),
};
