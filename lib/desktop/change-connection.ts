/**
 * File > Change connection… and the sign-in page's "Use my organisation's Bulwark
 * instead": the app restarts on its first screen, which asks how to connect. That's a
 * restart with every window closing, so it asks first, in the app's own question window,
 * and says the accounts stay. The welcome tips were seen before; they don't come back
 * after it (settings-p3-5, desktop-p3-2).
 */

import { getDesktopBridge } from './bridge';
import { askInWindow } from './dialog-window';
import { markWelcomeTipsSeen } from '@/lib/welcome-tips';

export interface ChangeConnectionText {
  title: string;
  message: string;
  confirm: string;
  cancel: string;
}

/** Only a shell that can do it offers it. */
export function changeConnectionAvailable(): boolean {
  return typeof getDesktopBridge()?.menu?.changeConnection === 'function';
}

/** Asks, then restarts. False when the answer was no, or nothing could ask. */
export async function askAndChangeConnection(text: ChangeConnectionText): Promise<boolean> {
  const change = getDesktopBridge()?.menu?.changeConnection;
  if (typeof change !== 'function') return false;
  const asked = askInWindow({
    title: text.title,
    message: text.message,
    buttons: [{ label: text.cancel, variant: 'secondary' }, { label: text.confirm }],
    defaultIndex: 1,
  });
  if (!asked) return false;
  const answer = await asked.answer;
  if (!answer || answer === 'failed' || !('button' in answer) || answer.button !== 1) return false;
  markWelcomeTipsSeen();
  return change();
}
