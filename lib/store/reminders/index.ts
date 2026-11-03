import type { StoreArea } from '../area';
import { dismiss, holdFired, readBatch, readReminder, releaseMissed, snooze, takeMissed, tick, type TickParams } from './ledger';
import { REMINDER_MIGRATIONS } from './schema';

export const remindersArea: StoreArea = {
  name: 'reminders',
  migrations: REMINDER_MIGRATIONS,
  methods: {},
  syncers: [],
  calls: {
    'reminders.tick': (ctx, params: TickParams) => tick(ctx.db, ctx.now(), params),
    'reminders.takeMissed': (ctx, params: { timeZone: string }) => takeMissed(ctx.db, ctx.now(), params),
    'reminders.releaseMissed': (ctx, params: { batch: number }) => releaseMissed(ctx.db, ctx.now(), params.batch),
    'reminders.batch': (ctx, params: { batch: number }) => readBatch(ctx.db, params.batch),
    'reminders.hold': (ctx, params: { keys: string[] }) => holdFired(ctx.db, ctx.now(), params.keys),
    'reminders.snooze': (ctx, params: { key: string; minutes: number }) => snooze(ctx.db, ctx.now(), params.key, params.minutes),
    'reminders.dismiss': (ctx, params: { keys: string[] }) => dismiss(ctx.db, ctx.now(), params.keys),
    'reminders.get': (ctx, params: { key: string }) => readReminder(ctx.db, params.key),
  },
};
