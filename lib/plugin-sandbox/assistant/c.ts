// Area c of the assistant's host APIs, host side (see README.md): answering
// invitations, deleting events with undo, filter rules, batches of
// messages, the out-of-office's forward and changing settings.
//
// Two existing calls are taken over here and keep their permission and
// their behaviour for every plugin: calendar.deleteEvent now also returns
// an undo token, and vacation.get also says whether the out-of-office
// forwards mail.

import type { InstalledPlugin, Permission, VacationView } from '../../plugin-types';
import { useAuthStore } from '@/stores/auth-store';
import { useVacationStore } from '@/stores/vacation-store';
import { doVacationGet } from '../host-api-settings';
import { NOT_MINE } from './not-mine';
import { doCalendarDeleteWithUndo, doCalendarRespond, doCalendarUndoDelete } from './c.calendar';
import { doFiltersCreate, doFiltersList, doFiltersUndo } from './c.filters';
import { doEmailBatch, doEmailUndoBatch } from './c.batch';
import { doDescribeSettings, doSetSettings, doUndoSettings } from './c.settings';
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
  'app.describeSettings': 'settings:read',
  'app.setSettings': 'settings:change',
  'app.undoSettings': 'settings:change',
};

/** vacation.get, plus whether the out-of-office forwards mail while it is on. */
async function doVacationGetWithForward(): Promise<VacationView & VacationForwardField> {
  const view = await doVacationGet();
  return { ...view, forwardActive: useVacationStore.getState().forward?.enabled === true };
}

/** Runs a method of this area; NOT_MINE for any other. */
export async function dispatch(plugin: InstalledPlugin, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'calendar.respond': return doCalendarRespond(args[0], args[1]);
    case 'calendar.deleteEvent': return doCalendarDeleteWithUndo(plugin.id, args[0]);
    case 'calendar.undoDelete': return doCalendarUndoDelete(plugin.id, args[0]);
    case 'filters.list': return doFiltersList();
    case 'filters.create': return doFiltersCreate(plugin.id, args[0]);
    case 'filters.undo': return doFiltersUndo(plugin.id, args[0]);
    case 'email.batch': return doEmailBatch(plugin.id, args[0]);
    case 'email.undoBatch': return doEmailUndoBatch(plugin.id, args[0]);
    case 'vacation.get': return doVacationGetWithForward();
    case 'app.describeSettings': return doDescribeSettings(args[0]);
    case 'app.setSettings': return doSetSettings(plugin.id, args[0]);
    case 'app.undoSettings': return doUndoSettings(plugin.id, args[0]);
    default: return NOT_MINE;
  }
}

/** This area's flags in api.host.features, right now. */
export function features(): AreaHostFeaturesC {
  const client = useAuthStore.getState().client;
  return {
    answerInvitation: true,
    filterRules: client?.supportsSieve?.() === true,
    batchMail: true,
    changeSettings: true,
  };
}
