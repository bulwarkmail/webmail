/**
 * The two things main hands the embedded server while it runs. The server's host
 * (src/server/host.ts in the desktop repo) has no way into Next's bundles but globalThis,
 * so it calls what this leaves there. instrumentation.node.ts installs them, only in the
 * desktop build.
 */

import { captureDesktopMainError, type DesktopMainErrorInput } from '@/lib/error-reporting/server';
import { reschedule } from '@/lib/telemetry/sender';

const PRIVACY_CHANGED = Symbol.for('bulwark.desktop.privacyChanged');
const MAIN_ERRORS = Symbol.for('bulwark.desktop.mainErrors');
const MAIN_ERRORS_READY = Symbol.for('bulwark.desktop.mainErrorsReady');

type Holder = Record<symbol, unknown>;

function drainMainErrors(holder: Holder): void {
  const queue = holder[MAIN_ERRORS];
  if (!Array.isArray(queue)) return;
  for (const error of queue.splice(0)) void captureDesktopMainError(error as DesktopMainErrorInput);
}

export function installDesktopServerLinks(): void {
  const holder = globalThis as unknown as Holder;
  // Turning telemetry on starts the heartbeat now, without a restart. Off needs no
  // more than the value: sendOnce reads it before every send.
  holder[PRIVACY_CHANGED] = () => {
    void reschedule();
  };
  // Errors from before this ran are waiting in the queue.
  holder[MAIN_ERRORS_READY] = () => drainMainErrors(holder);
  drainMainErrors(holder);
}
