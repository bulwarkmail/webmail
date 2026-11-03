import type { StoreArea } from '../area';
import { MAIL_CALLS } from './calls';
import { MAIL_METHODS } from './methods';
import { MAIL_MIGRATIONS } from './schema';
import { applyMailScope, mailUsage } from './scope';
import { SEARCH_MIGRATIONS } from './search-schema';
import { identitySyncer, mailSyncer, quotaSyncer } from './sync';

export const mailArea: StoreArea = {
  name: 'mail',
  migrations: [...MAIL_MIGRATIONS, ...SEARCH_MIGRATIONS],
  methods: MAIL_METHODS,
  syncers: [mailSyncer, identitySyncer, quotaSyncer],
  calls: MAIL_CALLS,
  applyScope: applyMailScope,
  usage: mailUsage,
  keptBytes: (ctx) => Number(ctx.db.get<{ n: number | null }>('SELECT SUM(size) AS n FROM blob')?.n ?? 0),
};
