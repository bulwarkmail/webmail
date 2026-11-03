import type { StoreArea } from '../area';
import { CONTACT_METHODS } from './methods';
import { listConflicts, pendingCount } from './pending';
import { CONTACT_MIGRATIONS } from './schema';
import { contactsSyncer } from './sync';

export const contactsArea: StoreArea = {
  name: 'contacts',
  migrations: CONTACT_MIGRATIONS,
  methods: CONTACT_METHODS,
  syncers: [contactsSyncer],
  calls: {
    /** Sends what's queued, in the next sync pass, and says what's left. */
    'contacts.flush': async (ctx) => {
      await ctx.requestSync();
      return { pending: pendingCount(ctx.db), conflicts: listConflicts(ctx.db).length };
    },
    /** How many cards have edits waiting to go out. */
    'contacts.pending': (ctx) => pendingCount(ctx.db),
    /** Edits the server refused or that met a change there. The server's copy is the one kept. */
    'contacts.conflicts': (ctx) => listConflicts(ctx.db),
    /** The user has seen this one. */
    'contacts.dismissConflict': (ctx, params: { id: number }) => {
      ctx.db.run('DELETE FROM contact_conflict WHERE id = ?', [params.id]);
    },
  },
};
