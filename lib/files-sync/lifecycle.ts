/**
 * How Files on this computer follows an account out: sign-out, a wipe, a refused login. Hooked
 * in where edit-in-place's copies are (lib/desktop/edit-attachments.ts): the wipe registry, the
 * sign-out tasks, the auth store's word on a refused login, and the account list.
 *
 * - Sign-out: the drive goes (`signed-out`: the next sign-in brings it back) and the account's
 *   folders stop syncing until then; nothing is deleted from them.
 * - A wipe (remote, from settings, the organisation's): `wipe`. The drive goes with everything
 *   in it; the folders are forgotten, their files stay.
 * - A refused login the server was sure of (`invalid_grant`, a lasting 401): `refused`, as a
 *   wipe for these. An unsure one, or the organisation's idle limit, is a sign-out: a single
 *   bad answer at a start can be a server in trouble, and deleting the drive's unsynced edits
 *   for that would lose work.
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

/** Signed out without a host running: the drive still goes. */
async function signedOutWithoutHost(account: string): Promise<void> {
  const drive = claimFilesControls()?.drive;
  if (!drive) return;
  const wanted = account === 'all' ? await drive.state().then((state) => state.wanted, () => [] as string[]) : [account];
  for (const id of wanted) await drive.disable(id, 'signed-out').catch(() => {});
}

async function remove(account: string | null, reason: 'wipe' | 'refused'): Promise<void> {
  if (running) {
    await running.removeAccountData(account, reason);
    return;
  }
  const controls = claimFilesControls();
  if (controls) await removeAccountData(controls, account, reason);
}

let registered = false;

export function registerFilesSyncLifecycle(): void {
  if (registered || typeof window === 'undefined' || isPopoutWindow()) return;
  registered = true;
  onDeviceWipe((account) => remove(account, 'wipe').catch(() => {}));
  onCredentialsRejected((account, certain, kind) => {
    if (certain && kind === 'refused') void remove(account, 'refused').catch(() => {});
  });
  onBeforeSignOut(async (account) => {
    if (running) await running.signedOut(account).catch(() => {});
    else await signedOutWithoutHost(account);
  });
  onAccountRemoved((account, reason) => {
    // A wipe has its own way out, above.
    if (reason === 'wiped') return;
    if (running) void running.signedOut(account).catch(() => {});
    else void signedOutWithoutHost(account);
  });
}

/** Tests only. */
export function resetFilesSyncLifecycleForTests(): void {
  registered = false;
  running = null;
}
