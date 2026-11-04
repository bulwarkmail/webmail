import type { StoreArea, StoreContext } from '../area';
import { dismiss, holdFired, readBatch, readReminder, releaseMissed, renewMissed, settleMissed, snooze, takeMissed, tick, type TickParams } from './ledger';
import { REMINDER_MIGRATIONS } from './schema';

const CALENDARS = 'urn:ietf:params:jmap:calendars';

/** For a meeting in the own and a shared calendar: the own copy. */
function primaryAccount(ctx: Pick<StoreContext, 'session'>): string | undefined {
  return ctx.session.primaryAccounts[CALENDARS];
}

export const remindersArea: StoreArea = {
  name: 'reminders',
  migrations: REMINDER_MIGRATIONS,
  methods: {},
  syncers: [],
  calls: {
    'reminders.tick': (ctx, params: TickParams) => tick(ctx.db, ctx.now(), { ...params, prefer: primaryAccount(ctx) }),
    'reminders.takeMissed': (ctx, params: { timeZone: string }) => takeMissed(ctx.db, ctx.now(), { ...params, prefer: primaryAccount(ctx) }),
    'reminders.releaseMissed': (ctx, params: { batch: number }) => releaseMissed(ctx.db, ctx.now(), params.batch),
    'reminders.renewMissed': (ctx, params: { batch: number }) => renewMissed(ctx.db, ctx.now(), params.batch),
    'reminders.settleMissed': (ctx, params: { batch: number }) => settleMissed(ctx.db, ctx.now(), params.batch),
    'reminders.batch': (ctx, params: { batch: number }) => readBatch(ctx.db, params.batch),
    'reminders.hold': (ctx, params: { keys: string[] }) => holdFired(ctx.db, ctx.now(), params.keys),
    'reminders.snooze': (ctx, params: { key: string; minutes: number }) => snooze(ctx.db, ctx.now(), params.key, params.minutes),
    'reminders.dismiss': (ctx, params: { keys: string[] }) => dismiss(ctx.db, ctx.now(), params.keys),
    'reminders.get': (ctx, params: { key: string }) => readReminder(ctx.db, params.key),
  },
};
