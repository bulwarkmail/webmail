// Area c of the assistant's host APIs, host side (see README.md): answering
// invitations, deleting events with undo, filter rules, batches of
// messages, the out-of-office's forward and changing settings.
//
// Three existing calls are taken over here and keep their permission:
// calendar.deleteEvent now also returns an undo token, vacation.get also
// says whether the out-of-office forwards mail, and vacation.set refuses,
// for every plugin, to switch the reply on while it forwards mail or while
// that can't be read.

import type { InstalledPlugin, Permission, VacationView } from '../../plugin-types';
import { useAuthStore } from '@/stores/auth-store';
import { useVacationStore } from '@/stores/vacation-store';
import { doVacationGet, doVacationSet } from '../host-api-settings';
import { isPlainRecord, sessionClient } from '../host-api-input';
import { NOT_MINE } from './not-mine';
import { pluginHasPermission } from '../permissions';
import { doFiltersCreate, doFiltersList, doFiltersUndo } from './c.filters';
import { doEmailBatch, doEmailUndoBatch } from './c.batch';
import type { AreaHostFeaturesC, VacationForwardField } from './c.types';

/** Method → permission, joined into PERM_PER_METHOD. */
export const PERMS: Readonly<Record<string, Permission | null>> = {
  'calendar.respond': 'calendar:respond',
  'calendar.deleteEvent': 'calendar:write',
  'calendar.undoDelete': 'calendar:write',
  'filters.list': 'filters:read',
  'filters.create': 'filters:write',
  'filters.undo': 'filters:write',
  'email.batch': 'email:write',
  'email.undoBatch': 'email:write',
  'vacation.get': 'vacation:read',
  'vacation.set': 'vacation:write',
  'app.describeSettings': 'settings:read',
  'app.setSettings': 'settings:change',
  'app.undoSettings': 'settings:change',
};

/**
 * Whether the out-of-office forwards mail while it is on: true, false, or
 * null when the account has filters but they couldn't be read.
 */
function forwardActive(): boolean | null {
  const state = useVacationStore.getState();
  if (state.forwardUnknown) return null;
  return state.forward?.enabled === true;
}

/** vacation.get, plus whether the out-of-office forwards mail while it is on. */
async function doVacationGetWithForward(): Promise<VacationView & VacationForwardField> {
  const view = await doVacationGet();
  return { ...view, forwardActive: forwardActive() };
}

/**
 * vacation.set as before, but no plugin may switch the reply on while the
 * out-of-office forwards mail to another address (set in Settings > Out of
 * office) or while that can't be read: switching it on would start sending
 * the user's mail elsewhere.
 */
async function doVacationSetGuarded(input: unknown): Promise<VacationView | null> {
  const method = 'vacation.set';
  if (isPlainRecord(input) && input.isEnabled === true) {
    const client = sessionClient(method);
    await useVacationStore.getState().fetchVacationResponse(client);
    const forward = forwardActive();
    if (forward !== false) {
      throw new Error(forward === null
        ? `${method}: whether the out-of-office forwards mail can't be read right now, so it can't be switched on here; use Settings > Out of office`
        : `${method}: the out-of-office forwards mail to another address, so a plugin can't switch it on; use Settings > Out of office`);
    }
  }
  return doVacationSet(input);
}

// Loaded on first use: both reach the calendar store, which registers itself
// with the settings store on import. host-features imports this file, and
// every view that offers plugin slots imports host-features.
const calendar = () => import('./c.calendar');
const settings = () => import('./c.settings');

/** Runs a method of this area; NOT_MINE for any other. */
export async function dispatch(plugin: InstalledPlugin, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'calendar.respond': return (await calendar()).doCalendarRespond(args[0], args[1]);
    case 'calendar.deleteEvent': return (await calendar()).doCalendarDeleteWithUndo(plugin.id, args[0]);
    case 'calendar.undoDelete': return (await calendar()).doCalendarUndoDelete(plugin.id, args[0]);
    case 'filters.list': return doFiltersList();
    case 'filters.create': return doFiltersCreate(plugin.id, args[0]);
    case 'filters.undo': return doFiltersUndo(plugin.id, args[0]);
    case 'email.batch': return doEmailBatch(plugin.id, args[0]);
    case 'email.undoBatch': return doEmailUndoBatch(plugin.id, args[0]);
    case 'vacation.get': return doVacationGetWithForward();
    case 'vacation.set': return doVacationSetGuarded(args[0]);
    case 'app.describeSettings': return (await settings()).doDescribeSettings(args[0]);
    case 'app.setSettings': return (await settings()).doSetSettings(plugin.id, args[0]);
    case 'app.undoSettings': return (await settings()).doUndoSettings(plugin.id, args[0]);
    default: return NOT_MINE;
  }
}

/**
 * This area's flags in api.host.features, right now. For one plugin, the
 * calls behind a new optional permission count only once it was granted (a
 * plugin enabled before an update lacks them until turned off and on).
 */
export function features(plugin?: InstalledPlugin): AreaHostFeaturesC {
  const client = useAuthStore.getState().client;
  const granted = (permission: Permission) => !plugin || pluginHasPermission(plugin, permission);
  return {
    answerInvitation: granted('calendar:respond'),
    filterRules: client?.supportsSieve?.() === true,
    batchMail: true,
    changeSettings: granted('settings:change'),
  };
}
