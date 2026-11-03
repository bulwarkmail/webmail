// Area c of the assistant's host APIs, inside the plugin sandbox (see README.md).

import type { CallApi, RuntimeAdditions } from './runtime';
import type {
  FilterRuleInput, InvitationAnswer, MailBatchInput, SettingValue,
} from './c.types';

/** The methods this area adds to the plugin's api, by namespace. */
export function runtime(callApi: CallApi): RuntimeAdditions {
  return {
    calendar: {
      // Answer an invitation in a message of the user's own account, as the
      // reader's banner does; the server sends the reply to the organiser
      // (permission calendar:respond).
      respond: (emailId: string, status: InvitationAnswer) => callApi('calendar.respond', [emailId, status]),
      // Put back an event calendar.deleteEvent deleted, from its undo token (calendar:write).
      undoDelete: (undoToken: string) => callApi('calendar.undoDelete', [undoToken]),
    },
    filters: {
      // The account's filter rules (filters:read).
      list: () => callApi('filters.list', []),
      // Add a rule at the top; no forwarding, rejecting or deleting rules (filters:write).
      create: (rule: FilterRuleInput) => callApi('filters.create', [rule]),
      undo: (undoToken: string) => callApi('filters.undo', [undoToken]),
    },
    email: {
      // One change to up to 200 messages of the account, with one Undo (email:write).
      batch: (batch: MailBatchInput) => callApi('email.batch', [batch]),
      undoBatch: (undoToken: string) => callApi('email.undoBatch', [undoToken]),
    },
    app: {
      // Settings in the user's language: label, page, current and new value (settings:read).
      describeSettings: (changes: Record<string, SettingValue> | string[]) => callApi('app.describeSettings', [changes]),
      // Change settings on the allow-list (settings:change).
      setSettings: (changes: Record<string, SettingValue>) => callApi('app.setSettings', [changes]),
      undoSettings: (undoToken: string) => callApi('app.undoSettings', [undoToken]),
    },
  };
}
