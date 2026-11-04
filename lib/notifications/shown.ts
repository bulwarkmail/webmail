/**
 * The notifications on screen, for closing them. Electron has no answer to
 * `getNotifications()`: its promise stays pending for good, so nothing may wait on
 * it without a limit. A wipe that did never got to the keys.
 */

const SHOWN_WAIT_MS = 1_000;

/** Null: no answer in time, and asking again won't get one. */
export async function shownNotifications(
  registration: Pick<ServiceWorkerRegistration, 'getNotifications'>,
  filter?: GetNotificationOptions,
  waitMs = SHOWN_WAIT_MS,
): Promise<Notification[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      registration.getNotifications(filter),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
