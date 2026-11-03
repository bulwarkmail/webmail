import { getDesktopBridge } from './bridge';

/**
 * Takes back what the user allowed in this session's certificate dialogs: the next
 * account at this computer gets asked. A refusal stays (it lasts until the app quits),
 * and so does a stored yes for an instance, which is about the instance and not the
 * person. Nothing happens in a browser or on a shell without the call.
 */
export function clearKeystoreGrants(): void {
  void Promise.resolve(getDesktopBridge()?.keystore?.clearGrants?.()).catch(() => {});
}
