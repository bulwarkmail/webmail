import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FilterRule, SieveCapabilities, SieveScript } from '@/lib/jmap/sieve-types';
import { parseScript, type ParseResult } from '@/lib/sieve/parser';
import { FILTERS_SCRIPT_NAME, generateScript, VACATION_SCRIPT_NAME } from '@/lib/sieve/generator';
import { filterHooks } from '@/lib/plugin-hooks';
import type { FilterRuleView } from '@/lib/plugin-types';

/**
 * One account's filters script, read and written against an explicit
 * (client, accountId) pair.
 *
 * The filter store keeps a single account's rules for the Settings panel. A
 * rule made from a message belongs to that message's account, which can be
 * another login or another Sieve account, so it must never go through the
 * store's state: that would upload one account's rules into another's script.
 */

/** The account's filters as the server has them right now. */
export interface AccountFilters {
  accountId: string;
  /** The script Bulwark writes: the active non-vacation script, else the first one. */
  script: SieveScript | null;
  /** The script's content, byte for byte ('' when there is no script). */
  content: string;
  parsed: ParseResult;
  /** The script that is active now, which may be the vacation script, or none. */
  activeScriptId: string | null;
  includeVacation: boolean;
  capabilities: SieveCapabilities | null;
}

/** The script was edited by hand and the builder cannot read it back. */
export class OpaqueFiltersError extends Error {
  constructor() {
    super('The filters script was edited by hand');
    this.name = 'OpaqueFiltersError';
  }
}

/** The script changed after the write that is being undone. */
export class FiltersChangedError extends Error {
  constructor() {
    super('The filters script changed since');
    this.name = 'FiltersChangedError';
  }
}

/** A plugin stopped the save through onBeforeFiltersSave; nothing was written. */
export class FiltersSaveVetoedError extends Error {
  constructor() {
    super('A plugin stopped saving the filters');
    this.name = 'FiltersSaveVetoedError';
  }
}

/**
 * A filter rule as plugins see it. Only what the rule matches and does: the
 * raw Sieve block of a rule written elsewhere is left out, since it can hold
 * anything a hand-edited script holds.
 */
export function filterRuleToView(rule: FilterRule): FilterRuleView {
  return {
    id: rule.id,
    name: rule.name,
    isActive: rule.enabled,
    conditions: rule.conditions.map((c) => ({
      field: c.field,
      comparator: c.comparator,
      value: Array.isArray(c.value) ? [...c.value] : c.value,
      ...(c.headerName ? { headerName: c.headerName } : {}),
    })),
    actions: rule.actions.map((a) => ({
      type: a.type,
      ...(a.value !== undefined ? { value: a.value } : {}),
      ...(a.mailboxId ? { mailboxId: a.mailboxId } : {}),
      ...(a.keepCopy !== undefined ? { keepCopy: a.keepCopy } : {}),
    })),
  };
}

/** Asks onBeforeFiltersSave; throws FiltersSaveVetoedError when a plugin says no. */
export async function assertFiltersSaveAllowed(rules: FilterRule[]): Promise<void> {
  if (filterHooks.onBeforeFiltersSave.size === 0) return;
  if (!(await filterHooks.onBeforeFiltersSave.intercept({ rules: rules.map(filterRuleToView) }))) {
    throw new FiltersSaveVetoedError();
  }
}

export function supportsInclude(capabilities: SieveCapabilities | null): boolean {
  return capabilities?.sieveExtensions?.includes('include') ?? false;
}

// Let plugins graft their managed sections (e.g. an inbox-category
// classifier) into the script before it becomes the active one. A handler
// returning a non-string is ignored to keep the upload valid.
export async function applyScriptTransforms(content: string, accountId: string | null): Promise<string> {
  const transformed = await filterHooks.onSieveScriptGenerate.transform(content, { accountId });
  return typeof transformed === 'string' && transformed.trim().length > 0 ? transformed : content;
}

export async function readAccountFilters(client: IJMAPClient, accountId: string): Promise<AccountFilters> {
  const capabilities = client.getSieveCapabilities(accountId);
  const allScripts = await client.getSieveScripts(accountId);
  // The server-managed 'vacation' script (RFC 9661 §4) can only be changed
  // through VacationResponse/set.
  const scripts = allScripts.filter(s => s.name !== VACATION_SCRIPT_NAME);
  // Writing activates the filters script, which switches off an active
  // server vacation script. Include it instead so both keep working.
  const vacationActive =
    allScripts.some(s => s.name === VACATION_SCRIPT_NAME && s.isActive) && supportsInclude(capabilities);
  // Bulwark's own script when none is active: a host's script that its
  // server rules include must not be taken for the filters.
  const script = scripts.find(s => s.isActive) || scripts.find(s => s.name === FILTERS_SCRIPT_NAME) || scripts[0] || null;
  const activeScriptId = allScripts.find(s => s.isActive)?.id ?? null;

  if (!script) {
    return {
      accountId,
      script: null,
      content: '',
      parsed: { rules: [], isOpaque: false, externalRequires: [] },
      activeScriptId,
      includeVacation: vacationActive,
      capabilities,
    };
  }

  const content = await client.getSieveScriptContent(script.blobId, accountId);
  const parsed = parseScript(content);
  return {
    accountId,
    script,
    content,
    parsed,
    activeScriptId,
    includeVacation: !parsed.isOpaque && (!!parsed.includeVacation || vacationActive),
    capabilities,
  };
}

/** The script for `rules`, keeping the account's vacation, its forwarding and external requires. */
export function renderFiltersScript(
  rules: FilterRule[],
  filters: Pick<AccountFilters, 'parsed' | 'includeVacation' | 'capabilities'>,
): string {
  return generateScript(rules, filters.parsed.vacation, {
    externalRequires: filters.parsed.externalRequires,
    includeVacation: filters.includeVacation,
    vacationForward: filters.parsed.vacationForward,
    vacationAudience: filters.parsed.vacationAudience,
    extensions: filters.capabilities?.sieveExtensions,
    serverRules: filters.parsed.serverRules,
  });
}

/**
 * Upload `content` as the account's filters script and make it the active
 * one: plugins transform it first, the existing script is updated (or a
 * "filters" script created), and the filter hooks hear about it.
 */
export async function writeFiltersScript(
  client: IJMAPClient,
  accountId: string | null,
  content: string,
  scriptId: string | null,
): Promise<{ scriptId: string; content: string }> {
  const transformed = await applyScriptTransforms(content, accountId);
  let id = scriptId;
  if (id) {
    await client.updateSieveScript(id, transformed, true, accountId || undefined);
  } else {
    id = (await client.createSieveScript(FILTERS_SCRIPT_NAME, transformed, true, accountId || undefined)).id;
  }
  void filterHooks.onFiltersSave.emit({ accountId });
  void filterHooks.onSieveScriptChange.emit({ accountId, script: transformed });
  return { scriptId: id, content: transformed };
}

/** What a write replaced, so it can be put back exactly. */
export interface FiltersChange {
  accountId: string;
  scriptId: string;
  /** The content that was uploaded. */
  written: string;
  rules: FilterRule[];
  previous: {
    /** null when the write created the script. */
    scriptId: string | null;
    content: string;
    activeScriptId: string | null;
  };
}

/**
 * Read the account's script from the server, let `modify` change its rules,
 * and write the result back. The script is read right before the write, so
 * a stale copy (the store's, or one another device has changed since) is
 * never uploaded. `modify` returns null when there is nothing to write.
 * Hand-edited scripts are refused: they are never rewritten from a rule.
 */
export async function updateAccountFilters(
  client: IJMAPClient,
  accountId: string,
  modify: (rules: FilterRule[], filters: AccountFilters) => FilterRule[] | null,
): Promise<FiltersChange | null> {
  const filters = await readAccountFilters(client, accountId);
  if (filters.parsed.isOpaque) throw new OpaqueFiltersError();
  const rules = modify(filters.parsed.rules, filters);
  if (!rules) return null;
  await assertFiltersSaveAllowed(rules);
  const written = await writeFiltersScript(
    client, accountId, renderFiltersScript(rules, filters), filters.script?.id ?? null,
  );
  return {
    accountId,
    scriptId: written.scriptId,
    written: written.content,
    rules,
    previous: {
      scriptId: filters.script?.id ?? null,
      content: filters.content,
      activeScriptId: filters.activeScriptId,
    },
  };
}

/**
 * Undo `change`: the script gets its previous bytes back and whichever
 * script was active before is active again; a script the write created is
 * removed. Refused with FiltersChangedError when the script is no longer
 * what the write left, so a later edit (from here or another device) is not
 * thrown away.
 */
export async function restoreAccountFilters(client: IJMAPClient, change: FiltersChange): Promise<void> {
  const { accountId, scriptId, previous } = change;
  const scripts = await client.getSieveScripts(accountId);
  const current = scripts.find(s => s.id === scriptId);
  if (!current) throw new FiltersChangedError();
  const content = await client.getSieveScriptContent(current.blobId, accountId);
  if (content !== change.written) throw new FiltersChangedError();

  const restoreActive = async () => {
    if (previous.activeScriptId === scriptId) return;
    if (previous.activeScriptId) await client.activateSieveScript(previous.activeScriptId, accountId);
    else await client.deactivateSieveScript(accountId);
  };

  if (previous.scriptId) {
    await client.updateSieveScript(scriptId, previous.content, previous.activeScriptId === scriptId, accountId);
    await restoreActive();
    void filterHooks.onSieveScriptChange.emit({ accountId, script: previous.content });
  } else {
    // An active script cannot be destroyed (RFC 9661), so switch back first.
    await restoreActive();
    await client.deleteSieveScript(scriptId, accountId);
  }
  void filterHooks.onFiltersSave.emit({ accountId });
}
