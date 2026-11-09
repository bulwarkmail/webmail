/**
 * One path for everything Bulwark does to a message on its way out, for
 * every surface that sends: the composer and quick reply. Features register
 * here instead of patching each send function:
 *
 * - pre-send checks run before anything is sent and may ask the user
 *   (the external-recipient confirm);
 * - finalisers change the bodies that go out (the organisation signature
 *   check, the legal disclaimer). They run on sends only, never on drafts,
 *   so a re-opened draft never carries what they add. Stage `body` runs on
 *   the message as written, before plugins see it; stage `last` runs after
 *   the plugins' onTransformOutgoingEmail and before a plugin signs or
 *   encrypts the message (onComposeSend), so what it adds goes below
 *   everything a plugin added.
 *
 * With nothing registered both are no-ops.
 */

import { debug } from '@/lib/debug';
import { whenPolicySettled } from '@/stores/policy-store';

// 'plugin-forward': a plugin forwarding a message (api.email.forward).
// 'report-phishing': a phishing report (lib/phishing-report.ts). It goes to
// the admin's address and is not the user's mail, so it never runs the
// checks, the finalisers, the classification label or plugins'
// onBeforeEmailSend; the surface names it for code that has to tell.
export type SendSurface = 'composer' | 'quick-reply' | 'calendar-invitation' | 'plugin-forward' | 'report-phishing';

export interface OutgoingContext {
  surface: SendSurface;
  /** Recipient addresses, without names. */
  to: string[];
  cc: string[];
  bcc: string[];
  /** The From address: the identity's, or one typed over it in the composer. */
  fromEmail?: string;
  identityId?: string;
  /**
   * The identity the message goes out from (its own address, never a From
   * typed over it) and the signed-in account (AccountEntry id) it goes out
   * through; the active account when left out. identityId can name an
   * identity of another account ("<account>::<id>"). Checks and finalisers
   * use that account's policy and identities.
   */
  sender?: { name: string; email: string; accountId?: string | null };
  /** compose, reply, replyAll or forward; quick reply is a reply. */
  mode: 'compose' | 'reply' | 'replyAll' | 'forward';
  /** Plain-text-only message (no HTML part). */
  plainText: boolean;
  /**
   * The composer's "Forwarded message" line in the UI language, where the
   * forwarded original starts; finalisers looking for what the user wrote
   * stop there.
   */
  forwardedSeparator?: string;
}

export interface OutgoingBodies {
  /** The HTML part; undefined for a plain-text-only message. */
  html?: string;
  text: string;
}

/** Changes the bodies; must return them unchanged when it has nothing to do. */
export type OutgoingFinalizer = (bodies: OutgoingBodies, context: OutgoingContext) => OutgoingBodies;

/** Resolves false to stop the send (after telling the user why, or asking them). */
export type PreSendCheck = (context: OutgoingContext) => boolean | Promise<boolean>;

/** When a finaliser runs; see the top of this file. */
export type FinalizerStage = 'body' | 'last';

interface Entry<T> {
  id: string;
  order: number;
  run: T;
}

const finalizers: Record<FinalizerStage, Entry<OutgoingFinalizer>[]> = { body: [], last: [] };
const checks: Entry<PreSendCheck>[] = [];

function register<T>(list: Entry<T>[], id: string, order: number, run: T): () => void {
  const existing = list.findIndex((entry) => entry.id === id);
  if (existing >= 0) list.splice(existing, 1);
  list.push({ id, order, run });
  list.sort((a, b) => a.order - b.order);
  return () => {
    const index = list.findIndex((entry) => entry.id === id && entry.run === run);
    if (index >= 0) list.splice(index, 1);
  };
}

/**
 * Adds a finaliser; lower `order` runs first within its stage. Registering
 * the same id again replaces it. Returns the unregister function.
 */
export function registerOutgoingFinalizer(
  id: string,
  order: number,
  run: OutgoingFinalizer,
  stage: FinalizerStage = 'body',
): () => void {
  const other = stage === 'body' ? finalizers.last : finalizers.body;
  const moved = other.findIndex((entry) => entry.id === id);
  if (moved >= 0) other.splice(moved, 1);
  return register(finalizers[stage], id, order, run);
}

/** Adds a pre-send check; lower `order` asks first. Returns the unregister function. */
export function registerPreSendCheck(id: string, order: number, run: PreSendCheck): () => void {
  return register(checks, id, order, run);
}

/** The bodies after every finaliser of `stage` (the message as written, by default). */
export function finalizeOutgoing(
  bodies: OutgoingBodies,
  context: OutgoingContext,
  stage: FinalizerStage = 'body',
): OutgoingBodies {
  let current = bodies;
  for (const entry of [...finalizers[stage]]) {
    try {
      current = entry.run(current, context);
    } catch (error) {
      // A broken finaliser must not stop the mail; it goes out without its change.
      debug.error(`Outgoing finaliser ${entry.id} failed:`, error);
    }
  }
  return current;
}

/**
 * Runs the checks in order and stops at the first that says no. A check
 * that throws is skipped: the checks warn, they don't guard, and a bug in
 * one must not make sending impossible.
 */
export async function runPreSendChecks(context: OutgoingContext): Promise<boolean> {
  // The checks and what the composer adds after them (labels, signatures)
  // follow the organisation policy: wait for its first fetch.
  await whenPolicySettled();
  for (const entry of [...checks]) {
    try {
      if (!(await entry.run(context))) {
        debug.log('email', `Send stopped by the pre-send check ${entry.id}`);
        return false;
      }
    } catch (error) {
      debug.error(`Pre-send check ${entry.id} failed:`, error);
    }
  }
  return true;
}

/** For tests: forget every registration. */
export function resetSendPipeline(): void {
  finalizers.body.length = 0;
  finalizers.last.length = 0;
  checks.length = 0;
}
