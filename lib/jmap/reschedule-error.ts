/**
 * A reschedule canceled the original submission, could not create the
 * replacement, and put the original back. The message still goes out at its
 * old time, under a new submission id. `reason` is why the replacement
 * failed.
 */
export class RescheduleRestoredError extends Error {
  constructor(message: string, readonly restoredSubmissionId: string, readonly restoredSendAt?: string, readonly reason?: unknown) {
    super(message);
    this.name = 'RescheduleRestoredError';
  }
}
