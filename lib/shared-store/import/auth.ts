import { SESSION_LIMITS_COLLECTION, SESSION_LIMITS_ID, sessionLimitsLayout } from '@/lib/auth/session-age';
import { REVOCATIONS_ID, WOPI_COLLECTION, wopiRevocationsLayout } from '@/lib/wopi/revocation';
import { getStore } from '../index';
import type { ImportStep } from '../import';
import { localCollection } from '../local';
import type { CollectionOptions } from '../types';

/**
 * Import steps of part `auth` (#1066): the auth state that outlives a
 * restart.
 *
 * - session-limits-since: when the server first enforced the maximum
 *   session length. Without it the shared store would record a new time and
 *   legacy sessions would get a fresh allowance.
 * - WOPI revocations: office editor tokens revoked at sign-out, for up to
 *   six hours.
 *
 * Not imported, because they don't outlive the switch in any way that
 * matters:
 * - pairing grants, codes and the hand-off codes: in memory only, gone with
 *   the restart that turns on the shared store, as on any restart (they last
 *   two to five minutes);
 * - impersonation markers: they refuse a used hand-off link for at most 420
 *   seconds, and the links themselves live five minutes at most. Moving an
 *   install takes the deployment down for longer than that.
 * - sign-in budgets: counters of 15 minutes to a day; they start empty, as
 *   they do after every restart today.
 */

function copyStep(name: string, collection: string, layout: CollectionOptions, id: string): ImportStep {
  return {
    name,
    async run() {
      const doc = await localCollection(collection, layout).get(id);
      if (!doc) return 0;
      const written = await getStore().collection(collection, layout).put(id, doc.data, { ifVersion: null });
      return written.ok ? 1 : 0;
    },
  };
}

export const steps: ImportStep[] = [
  copyStep('session-limits-since', SESSION_LIMITS_COLLECTION, sessionLimitsLayout, SESSION_LIMITS_ID),
  copyStep('wopi-revocations', WOPI_COLLECTION, wopiRevocationsLayout, REVOCATIONS_ID),
];
