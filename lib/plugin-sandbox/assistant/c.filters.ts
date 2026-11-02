// Area c, filters: filters.list / create / undo over the model Settings >
// Filters uses (lib/filters/account-filters.ts). A rule is checked the way
// the rule editor checks it, and nothing that sends mail elsewhere or drops
// it may be in it: no forward or redirect, no reject (it answers the
// sender), no discard (it deletes), no keep. Moves and copies go only into
// folders of the filters' own account that nobody else shares.

import type { FilterAction, FilterCondition, FilterRule } from '../../jmap/sieve-types';
import type { IJMAPClient } from '../../jmap/client-interface';
import type { Mailbox } from '../../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useFilterStore } from '@/stores/filter-store';
import { useSettingsStore } from '@/stores/settings-store';
import {
  OpaqueFiltersError, readAccountFilters, restoreAccountFilters, updateAccountFilters, FiltersChangedError,
  FiltersSaveVetoedError, type FiltersChange,
} from '../../filters/account-filters';
import { insertRuleAtTop, mailboxSievePath } from '../../filters/quick-rules';
import { isValidSieveHeaderName } from '../../sieve/generator';
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY } from '../../thread-utils';
import { generateUUID } from '../../utils';
import { isPlainRecord, readId, readObject, readString, sessionClient } from '../host-api-input';
import { isSharedOut } from '../../mailbox-shared-out';
import { issueUndoToken, redeemUndoToken, undoAccount } from './c.undo';
import type {
  FilterCreateResult, FilterRuleActionType, FilterRuleField, FilterRuleInfo, FilterRuleOp, FiltersListView,
} from './c.types';

const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 10;
const MAX_VALUES = 20;
const MAX_VALUE = 500;

const ADDRESS_OPS: FilterRuleOp[] = ['contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'address_is', 'domain_is'];
const TEXT_OPS: FilterRuleOp[] = ['contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with'];
/** Which comparisons each field takes. */
export const FILTER_FIELD_OPS: Readonly<Record<FilterRuleField, FilterRuleOp[]>> = {
  from: ADDRESS_OPS, to: ADDRESS_OPS, cc: ADDRESS_OPS,
  subject: TEXT_OPS, body: ['contains', 'not_contains'], header: TEXT_OPS,
  size: ['greater_than', 'less_than'],
  attachment: ['has_any', 'has_type'],
};
/** The only actions a plugin's rule may have. */
export const FILTER_ACTIONS: readonly FilterRuleActionType[] = ['move', 'copy', 'mark_read', 'star', 'add_label', 'stop'];

function sieveClient(method: string): IJMAPClient {
  const client = sessionClient(method);
  if (!client.supportsSieve()) throw new Error(`${method}: the mail server has no filters`);
  return client;
}

/** The folders of the filters' account, as the server has them. */
async function sieveMailboxes(client: IJMAPClient, accountId: string): Promise<Mailbox[]> {
  return client.getMailboxes(accountId === client.getAccountId() ? undefined : accountId);
}

const tagIdOf = (keyword: string | undefined) => (keyword?.startsWith(KEYWORD_PREFIX)
  ? keyword.slice(KEYWORD_PREFIX.length)
  : keyword?.startsWith(KEYWORD_PREFIX_LEGACY) ? keyword.slice(KEYWORD_PREFIX_LEGACY.length) : keyword);

function ruleToInfo(rule: FilterRule, mailboxes: Mailbox[]): FilterRuleInfo {
  return {
    id: rule.id,
    name: rule.name,
    isActive: rule.enabled,
    editable: !rule.origin || rule.origin === 'bulwark',
    match: rule.matchType,
    conditions: rule.conditions.map((c) => ({
      field: c.field, op: c.comparator, value: Array.isArray(c.value) ? [...c.value] : c.value,
      ...(c.headerName ? { headerName: c.headerName } : {}),
    })),
    actions: rule.actions.map((a) => {
      if (a.type === 'move' || a.type === 'copy') {
        const box = a.mailboxId ? mailboxes.find((m) => m.id === a.mailboxId) : undefined;
        return { type: a.type, ...(a.mailboxId ? { mailboxId: a.mailboxId } : {}), folder: box ? mailboxSievePath(mailboxes, box.id) : (a.value ?? '') };
      }
      if (a.type === 'add_label') return { type: a.type, tagId: tagIdOf(a.value) ?? '' };
      if (a.type === 'forward') return { type: a.type, value: a.value ?? '' };
      return { type: a.type };
    }),
  };
}

/** The account's filter rules, and whether rules can be added. */
export async function doFiltersList(): Promise<FiltersListView> {
  const method = 'filters.list';
  const client = sessionClient(method);
  if (!client.supportsSieve()) return { supported: false, editable: false, rules: [] };
  const accountId = client.getSieveAccountId();
  const [filters, mailboxes] = await Promise.all([readAccountFilters(client, accountId), sieveMailboxes(client, accountId)]);
  if (filters.parsed.isOpaque) return { supported: true, editable: false, rules: [] };
  return { supported: true, editable: true, rules: filters.parsed.rules.map((r) => ruleToInfo(r, mailboxes)) };
}

function readValues(value: unknown, method: string, field: string): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > MAX_VALUES) throw new Error(`${method}: ${field} takes 1 to ${MAX_VALUES} values`);
  return list.map((v, i) => {
    const text = readString(v, method, `${field}[${i}]`, MAX_VALUE, { min: 1, trim: true });
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${method}: ${field} has a line break or a control character`);
    return text;
  });
}

function readCondition(entry: unknown, method: string, i: number): FilterCondition {
  const at = `conditions[${i}]`;
  const c = readObject(entry, method, at, ['field', 'op', 'value', 'headerName']);
  const field = c.field as FilterRuleField;
  const ops = FILTER_FIELD_OPS[field];
  if (!ops) throw new Error(`${method}: ${at}.field must be one of ${Object.keys(FILTER_FIELD_OPS).join(', ')}`);
  const op = c.op as FilterRuleOp;
  if (!ops.includes(op)) throw new Error(`${method}: ${at}.op for ${field} must be one of ${ops.join(', ')}`);
  const condition: FilterCondition = { field, comparator: op, value: '' };
  if (op === 'has_any') {
    if (c.value !== undefined && c.value !== '') throw new Error(`${method}: ${at} takes no value`);
  } else if (field === 'size') {
    const size = typeof c.value === 'number' ? String(c.value) : c.value;
    if (typeof size !== 'string' || !/^\d{1,10}$/.test(size)) throw new Error(`${method}: ${at}.value must be a size in bytes`);
    condition.value = size;
  } else {
    const values = readValues(c.value, method, `${at}.value`);
    condition.value = values.length === 1 ? values[0] : values;
  }
  if (field === 'header') {
    const name = readString(c.headerName, method, `${at}.headerName`, 100, { min: 1, trim: true });
    if (!isValidSieveHeaderName(name)) throw new Error(`${method}: ${at}.headerName is not a header name`);
    condition.headerName = name;
  } else if (c.headerName !== undefined) {
    throw new Error(`${method}: ${at}.headerName is only for field header`);
  }
  return condition;
}

function readAction(entry: unknown, method: string, i: number, mailboxes: Mailbox[]): FilterAction {
  const at = `actions[${i}]`;
  if (!isPlainRecord(entry)) throw new Error(`${method}: ${at} must be an object`);
  const type = entry.type;
  if (!FILTER_ACTIONS.includes(type as FilterRuleActionType)) {
    // Forward, redirect, reject, discard and keep are refused by name, so a
    // plugin (or a model behind it) hears that they are not allowed at all.
    throw new Error(`${method}: ${at}.type "${String(type)}" is not allowed; a rule may only ${FILTER_ACTIONS.join(', ')}`);
  }
  const a = readObject(entry, method, at, ['type', 'mailboxId', 'tagId']);
  if (type === 'move' || type === 'copy') {
    const id = readId(a.mailboxId, method, `${at}.mailboxId`);
    const box = mailboxes.find((m) => m.id === id);
    // Only the account's own folders, and none that is shared with others:
    // a rule must not file mail where other people read it.
    if (!box || box.isShared) {
      throw new Error(`${method}: ${at}.mailboxId is not a folder of this account that only the user reads`);
    }
    if (box.role === 'trash') throw new Error(`${method}: ${at} may not move mail to the trash`);
    if (a.tagId !== undefined) throw new Error(`${method}: ${at}.tagId is only for add_label`);
    return { type, mailboxId: id, value: mailboxSievePath(mailboxes, id) };
  }
  if (a.mailboxId !== undefined) throw new Error(`${method}: ${at}.mailboxId is only for move and copy`);
  if (type === 'add_label') {
    const tagId = readString(a.tagId, method, `${at}.tagId`, 100, { min: 1, trim: true });
    if (!useSettingsStore.getState().emailKeywords.some((k) => k.id === tagId)) throw new Error(`${method}: ${at}.tagId is not one of the user's tags`);
    return { type, value: tagId };
  }
  if (a.tagId !== undefined) throw new Error(`${method}: ${at}.tagId is only for add_label`);
  return { type: type as FilterAction['type'] };
}

/** The rule a plugin asked for, checked like the rule editor checks one. */
export function readFilterRule(input: unknown, method: string, mailboxes: Mailbox[]): FilterRule {
  const data = readObject(input, method, 'rule', ['name', 'match', 'conditions', 'actions']);
  const name = readString(data.name, method, 'name', 100, { min: 1, trim: true });
  const match = data.match === undefined ? 'all' : data.match;
  if (match !== 'all' && match !== 'any') throw new Error(`${method}: match must be all or any`);
  if (!Array.isArray(data.conditions) || data.conditions.length === 0 || data.conditions.length > MAX_CONDITIONS) {
    throw new Error(`${method}: conditions must hold 1 to ${MAX_CONDITIONS} conditions`);
  }
  if (!Array.isArray(data.actions) || data.actions.length === 0 || data.actions.length > MAX_ACTIONS) {
    throw new Error(`${method}: actions must hold 1 to ${MAX_ACTIONS} actions`);
  }
  const conditions = data.conditions.map((c, i) => readCondition(c, method, i));
  const actions = data.actions.map((a, i) => readAction(a, method, i, mailboxes));
  if (!actions.some((a) => a.type !== 'stop')) throw new Error(`${method}: the rule must do something besides stop`);
  const stop = actions.some((a) => a.type === 'stop');
  return {
    id: generateUUID(),
    name,
    enabled: true,
    matchType: match,
    conditions,
    actions: actions.filter((a) => a.type !== 'stop'),
    stopProcessing: stop,
  };
}

/** Let an open Settings > Filters page show the change. */
function refreshFilterStore(client: IJMAPClient, accountId: string): void {
  const filters = useFilterStore.getState();
  if (useAuthStore.getState().client === client && filters.selectedAccountId === accountId) {
    void filters.fetchFilters(client, accountId);
  }
}

/** Add a rule at the top of the account's filters. Resolves to its id and an undo token. */
export async function doFiltersCreate(pluginId: string, input: unknown): Promise<FilterCreateResult> {
  const method = 'filters.create';
  const client = sieveClient(method);
  const accountId = client.getSieveAccountId();
  const mailboxes = await sieveMailboxes(client, accountId);
  const rule = readFilterRule(input, method, mailboxes);
  // The share map isn't in the folder list: ask the server for each target
  // and the folders above it, and refuse a folder someone else reads.
  for (const action of rule.actions) {
    if ((action.type === 'move' || action.type === 'copy') && action.mailboxId
      && (await isSharedOut(client, mailboxes, action.mailboxId, accountId === client.getAccountId() ? undefined : accountId))) {
      throw new Error(`${method}: the folder "${action.value}" is shared with other people; a rule may not file mail there`);
    }
  }
  let change: FiltersChange | null;
  try {
    change = await updateAccountFilters(client, accountId, (rules) => insertRuleAtTop(rules, rule));
  } catch (err) {
    if (err instanceof OpaqueFiltersError) throw new Error(`${method}: the filters were edited by hand; add the rule in Settings > Filters`);
    if (err instanceof FiltersSaveVetoedError) throw new Error(`${method}: another plugin stopped the change`);
    throw err;
  }
  if (!change) throw new Error(`${method}: nothing was written`);
  refreshFilterStore(client, accountId);
  return { id: rule.id, undoToken: issueUndoToken(pluginId, undoAccount(client), 'filters', change) };
}

/** Take back a rule filters.create added: the script gets its earlier bytes back. */
export async function doFiltersUndo(pluginId: string, token: unknown): Promise<void> {
  const method = 'filters.undo';
  const client = sieveClient(method);
  const change = redeemUndoToken<FiltersChange>(method, pluginId, undoAccount(client), 'filters', token);
  try {
    await restoreAccountFilters(client, change);
  } catch (err) {
    if (err instanceof FiltersChangedError) throw new Error(`${method}: the filters changed since; change them in Settings > Filters`);
    throw err;
  }
  refreshFilterStore(client, change.accountId);
}
