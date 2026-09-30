/**
 * The server refused the change because of the iTIP messages it would send
 * (Stalwart 0.16.21+ fails the whole CalendarEvent/set with `forbidden`
 * when the account may not send scheduling messages). The same change
 * without `sendSchedulingMessages` can still be saved.
 */
export class SchedulingDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SchedulingDeniedError';
  }
}
