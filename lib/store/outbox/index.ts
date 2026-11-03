import type { StoreArea } from '../area';
import { OUTBOX_CALLS } from './calls';
import { emailSet, outboxOverlay } from './email-set';
import { OUTBOX_MIGRATIONS } from './schema';

export const outboxArea: StoreArea = {
  name: 'outbox',
  migrations: OUTBOX_MIGRATIONS,
  methods: { 'Email/set': emailSet },
  syncers: [],
  calls: OUTBOX_CALLS,
  overlay: outboxOverlay,
};
