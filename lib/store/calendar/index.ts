import type { StoreArea } from '../area';
import { CALENDAR_METHODS } from './methods';
import { CALENDAR_MIGRATIONS } from './schema';
import { applyCalendarScope, calendarSyncer, flushCalendar } from './sync';
import { listConflicts, resolveStandIns } from './writes';

export const calendarArea: StoreArea = {
  name: 'calendar',
  migrations: CALENDAR_MIGRATIONS,
  methods: CALENDAR_METHODS,
  syncers: [calendarSyncer],
  applyScope: applyCalendarScope,
  usage: (ctx) => {
    const row = ctx.db.get<{ bytes: number | null; items: number }>('SELECT SUM(LENGTH(json)) AS bytes, COUNT(*) AS items FROM calendar_event');
    return [{ part: 'calendar', bytes: Number(row?.bytes ?? 0), items: Number(row?.items ?? 0) }];
  },
  calls: {
    'calendar.flush': (ctx) => flushCalendar(ctx),
    'calendar.conflicts': (ctx) => listConflicts(ctx.db),
    /** How many writes wait to go out. */
    'calendar.pending': (ctx) => Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendar_pending')?.n ?? 0),
    'calendar.resolveStandIns': (ctx, params: { ids: string[] }) => resolveStandIns(ctx.db, params.ids),
    'calendar.dismissConflict': (ctx, params: { id: number }) => {
      ctx.db.run('DELETE FROM calendar_conflict WHERE id = ?', [params.id]);
    },
  },
};
