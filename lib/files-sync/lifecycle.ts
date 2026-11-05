/**
 * How Files on this computer follows an account out: sign-out, a wipe, a refused login. Hooked
 * in where edit-in-place's copies are (lib/desktop/edit-attachments.ts): the wipe registry, the
 * sign-out tasks, the auth store's word on a refused login, and the account list.
 *
 * - A sign-out the user chose: what waits is uploaded first (the gate in FilesSyncHost asks),
 *   then the drive goes (`signed-out`: the next sign-in brings it back with its pins; what still
 *   wasn't uploaded is copied to Documents by main) and the account's folders stop syncing until
 *   then; nothing is deleted from them.
 * - A sign-out nobody chose (the session or idle limit, a refused login, certain or not):
 *   `suspended`. The drive's folder, its edits and pins stay; it's only disconnected, and the
 *   next sign-in goes on where it stopped (pass-3 files-p3-3).
 * - A wipe (remote, from settings, the organisation's, at a forced sign-out where it says so):
 *   `wipe`. The drive goes with everything in it, edits not uploaded yet too: that's what a
 *   wipe is for. The folders are forgotten, their files stay.
 */

import { onCredentialsRejected } from '@/lib/offline/credentials-rejected';
import { onDeviceWipe } from '@/lib/offline/wipe-registry';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { onBeforeSignOut } from '@/lib/sign-out-cleanup';
import { onAccountRemoved } from '@/stores/account-store';
import { claimFilesControls } from './controls';
import { removeAccountData, type FilesSyncHost } from './host';

let running: FilesSyncHost | null = null;

export function setRunningFilesSyncHost(host: FilesSyncHost | null): void {
  running = host;
}

/** Signed out without a host running: the drive still goes (or, not chosen, disconnects). */
async function signedOutWithoutHost(account: string, chosen: boolean): Promise<void> {
  const drive = claimFilesControls()?.drive;
  if (!drive) return;
  const wanted = account === 'all' ? await drive.state().then((state) => state.wanted, () => [] as string[]) : [account];
  for (const id of wanted) await drive.disable(id, chosen ? 'signed-out' : 'suspended').catch(() => {});
}

function signedOut(account: string, chosen: boolean): Promise<void> {
  return running ? running.signedOut(account, chosen) : signedOutWithoutHost(account, chosen);
}

async function remove(account: string | null, reason: 'wipe'): Promise<void> {
  if (running) {
    await running.removeAccountData(account, reason);
    return;
  }
  const controls = claimFilesControls();
  if (controls) await removeAccountData(controls, account, reason);
}

let registered = false;
const stops: (() => void)[] = [];

export function registerFilesSyncLifecycle(): void {
  if (registered || typeof window === 'undefined' || isPopoutWindow()) return;
  registered = true;
  stops.push(onDeviceWipe((account) => remove(account, 'wipe').catch(() => {})));
  // A refused login is a sign-out nobody chose: nothing of the drive goes (a wipe still can).
  stops.push(onCredentialsRejected((account) => {
    void signedOut(account, false).catch(() => {});
  }));
  stops.push(onBeforeSignOut(async (account, options) => {
    await signedOut(account, options.userInitiated === true).catch(() => {});
  }));
  stops.push(onAccountRemoved((account, reason) => {
    // A wipe has its own way out, above.
    if (reason === 'wiped') return;
    void signedOut(account, reason === 'explicit').catch(() => {});
  }));
}

/** Tests only. */
export function resetFilesSyncLifecycleForTests(): void {
  for (const stop of stops.splice(0)) stop();
  registered = false;
  running = null;
}
