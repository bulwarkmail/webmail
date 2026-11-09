/**
 * Plugins' say before a user's mail goes out (onBeforeEmailSend), the same
 * for every surface that sends it: the composer (inline, pop-out, Pro tab),
 * quick reply and a plugin's forward (api.email.forward). The bus fails
 * closed: a handler that throws or runs out of time stops the send.
 *
 * Not run for mail Bulwark sends on its own (calendar invitations and RSVP
 * replies, read receipts, List-Unsubscribe mails, phishing reports) nor for
 * a crypto plugin's raw send, which happens after the composer's check.
 */

import { emailHooks } from '@/lib/plugin-hooks';
import type { OutgoingEmail } from '@/lib/plugin-types';
import { awaitSendGuards } from '@/lib/plugin-send-guards';
import { debug } from '@/lib/debug';

/**
 * allowed: send. vetoed: a plugin said no and told the user. failed: a
 * handler threw or ran out of time. guard-loading / guard-failed: a send
 * check the admin requires is still starting, or failed to start or was
 * turned off after errors (lib/plugin-send-guards.ts). Nobody told the user
 * about the last three yet.
 */
export type PluginSendCheckOutcome = 'allowed' | 'vetoed' | 'failed' | 'guard-loading' | 'guard-failed';

/**
 * Waits for the send checks the admin requires, then asks the plugins.
 * `build` makes the message they get; it runs only after that wait and only
 * while a plugin listens, so a check that was still starting at the click
 * gets the whole message (external recipients, attachment types), never the
 * cut-down one built for nobody.
 */
export async function runPluginSendCheck(build: () => OutgoingEmail | Promise<OutgoingEmail>): Promise<PluginSendCheckOutcome> {
  const down = await awaitSendGuards();
  if (down.length > 0) {
    debug.warn('email', `Send held: required send checks not running: ${down.map((g) => `${g.id} (${g.state})`).join(', ')}`);
    return down.some((g) => g.state === 'failed') ? 'guard-failed' : 'guard-loading';
  }
  if (emailHooks.onBeforeEmailSend.size === 0) return 'allowed';
  return emailHooks.onBeforeEmailSend.interceptOutcome(await build());
}

/** The message key in the `send_guards` namespace for a held send, or null. */
export function sendGuardMessageKey(outcome: PluginSendCheckOutcome): 'not_running' | 'stopped_working' | null {
  if (outcome === 'guard-loading') return 'not_running';
  if (outcome === 'guard-failed') return 'stopped_working';
  return null;
}

/** Bare lowercase addresses of a recipient list ("Name <a@b>" or "a@b"). */
function addressSet(list: readonly string[]): string {
  return list
    .map((entry) => (/<([^>]+)>\s*$/.exec(entry)?.[1] ?? entry).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

/** Whether a plugin's onTransformOutgoingEmail changed who the message goes to. */
export function recipientsChanged(
  before: Pick<OutgoingEmail, 'to' | 'cc' | 'bcc'>,
  after: Pick<OutgoingEmail, 'to' | 'cc' | 'bcc'>,
): boolean {
  return addressSet([...before.to, ...before.cc, ...before.bcc]) !== addressSet([...(after.to ?? []), ...(after.cc ?? []), ...(after.bcc ?? [])]);
}
