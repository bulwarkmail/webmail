/**
 * Waking up without stale state. After sleep, an unlock or a network change, the app
 * does what it does when a tab comes back into view: the JMAP client checks for state
 * changes and replaces a dead stream, the identities and policy refresh. Those are the
 * handlers already listening, so this only gives them the word. The hidden main window
 * of the desktop app never goes out of view, so without this they wouldn't hear it.
 * The local store hangs on the same two: `online` is setOnline(true) and a flush,
 * `visibilitychange` is a sync per account. It takes itself offline for a sleep through
 * addSleepHandler, in lib/desktop/system-events.ts.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { runSleepHandlers, runWakeHandlers } from '@/lib/desktop/system-events';
import { usePolicyStore } from '@/stores/policy-store';

/** A resume and an unlock usually come together. */
const WAKE_REPEAT_MS = 2000;

function wake(): void {
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('online'));
  const policy = usePolicyStore.getState();
  if (policy.loaded && !policy.fetching) void policy.fetchPolicy();
  runWakeHandlers();
}

export function startPowerWatch(): () => void {
  const bridge = getDesktopBridge()?.os;
  if (!bridge) return () => {};
  let lastWake = 0;
  const wakeOnce = () => {
    const now = Date.now();
    if (now - lastWake < WAKE_REPEAT_MS) return;
    lastWake = now;
    wake();
  };
  const stopPower = bridge.onPower((event) => {
    if (event === 'resume' || event === 'unlock-screen') wakeOnce();
    else if (event === 'suspend') runSleepHandlers();
  });
  // Wi-Fi to cable is a new network with no offline moment in between.
  const connection = (navigator as unknown as { connection?: EventTarget }).connection;
  connection?.addEventListener?.('change', wakeOnce);
  return () => {
    stopPower();
    connection?.removeEventListener?.('change', wakeOnce);
  };
}
