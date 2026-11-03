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

/**
 * Forgets which client certificate goes to which server, with what the app keeps of it in
 * memory, so the next account at this computer gets asked. Nothing happens in a browser or on
 * a shell without the call.
 */
export function clearDesktopCertificateChoices(): void {
  void Promise.resolve(getDesktopBridge()?.certificates?.clearChoices?.()).catch(() => {});
}

/**
 * Deletes the crash files on this computer. They can hold the mail of whoever was signed
 * in when the app crashed, so the next account at this computer doesn't get to send them.
 */
export function clearDesktopCrashFiles(): void {
  void Promise.resolve(getDesktopBridge()?.privacy?.deleteCrashes?.()).catch(() => {});
}
