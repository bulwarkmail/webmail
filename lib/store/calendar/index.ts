import type { StoreArea } from '../area';
import { CALENDAR_METHODS } from './methods';
import { CALENDAR_MIGRATIONS } from './schema';
import { calendarSyncer, flushCalendar } from './sync';
import { listConflicts, resolveStandIns } from './writes';

export const calendarArea: StoreArea = {
  name: 'calendar',
  migrations: CALENDAR_MIGRATIONS,
  methods: CALENDAR_METHODS,
  syncers: [calendarSyncer],
  calls: {
    'calendar.flush': (ctx) => flushCalendar(ctx),
    /** Edits the server hasn't got, for the question before a sign-out. */
    'calendar.pending': (ctx) => Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendar_pending')?.n ?? 0),
    'calendar.conflicts': (ctx) => listConflicts(ctx.db),
    'calendar.resolveStandIns': (ctx, params: { ids: string[] }) => resolveStandIns(ctx.db, params.ids),
    'calendar.dismissConflict': (ctx, params: { id: number }) => {
      ctx.db.run('DELETE FROM calendar_conflict WHERE id = ?', [params.id]);
    },
  },
};
