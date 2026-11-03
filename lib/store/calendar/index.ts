import type { StoreArea } from '../area';
import { CALENDAR_METHODS } from './methods';
import { CALENDAR_MIGRATIONS } from './schema';
import { calendarSyncer, flushCalendar } from './sync';
import { listConflicts } from './writes';

export const calendarArea: StoreArea = {
  name: 'calendar',
  migrations: CALENDAR_MIGRATIONS,
  methods: CALENDAR_METHODS,
  syncers: [calendarSyncer],
  calls: {
    'calendar.flush': (ctx) => flushCalendar(ctx),
    'calendar.conflicts': (ctx) => listConflicts(ctx.db),
    'calendar.dismissConflict': (ctx, params: { id: number }) => {
      ctx.db.run('DELETE FROM calendar_conflict WHERE id = ?', [params.id]);
    },
  },
};
