import type { FilterRule, FilterCondition, FilterAction, FilterMetadata, VacationAudience, VacationForward, VacationSieveConfig } from '@/lib/jmap/sieve-types';
import { debug } from '@/lib/debug';
import { PERIOD_REQUIRES, hasPeriod, periodTests, supportsPeriods } from '@/lib/sieve/period';
import { VACATION_FORWARD_MARKER, isValidVacationForward, normalizeVacationForward } from '@/lib/sieve/vacation-forward';
import { isValidVacationAudience, normalizeVacationAudience } from '@/lib/sieve/vacation-audience';
import { usesRegex } from '@/lib/sieve/regex';
import { renderServerRules } from '@/lib/sieve/server-rules';

const HEADER_MAP: Record<string, string> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  subject: 'Subject',
};

/** Fields whose header holds addresses, so the `address` test applies. */
const ADDRESS_FIELDS = new Set<FilterCondition['field']>(['from', 'to', 'cc']);

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Header names Stalwart's Sieve compiler accepts (sieve-rs, 0.16 and 1.0).
 * Anything else - a space, a dot, a colon - fails the whole script with
 * "Invalid header name".
 */
const SIEVE_HEADER_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function isValidSieveHeaderName(name: string): boolean {
  return SIEVE_HEADER_NAME_RE.test(name);
}

/** The header a condition tests; a header condition without a name tests X-Unknown. */
function conditionHeaderName(condition: FilterCondition): string {
  return condition.field === 'header'
    ? (condition.headerName?.trim() || 'X-Unknown')
    : HEADER_MAP[condition.field];
}

// Normalise the condition value to a non-empty string array. Single-value
// conditions stay one-element; arrays are filtered for empty strings.
function toValueList(value: string | string[]): string[] {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => (v ?? '').toString()).filter((v) => v.length > 0);
}

// Render one or many strings as a Sieve string-literal-or-list. Sieve treats
// `header :contains "From" ["a", "b"]` as "any of a, b" (built-in OR within
// the condition); the single-string form is emitted unchanged when len === 1
// so existing scripts and tests stay byte-identical.
function formatStringArg(values: string[], transform: (s: string) => string = (s) => s): string {
  if (values.length === 1) {
    return `"${escapeString(transform(values[0]))}"`;
  }
  return `[${values.map((v) => `"${escapeString(transform(v))}"`).join(', ')}]`;
}

function generateCondition(condition: FilterCondition): string {
  const { field, comparator, value } = condition;

  // Every message: there is nothing to compare.
  if (field === 'all') return 'true';

  if (field === 'size') {
    // Size is numeric, single value only. It is written unquoted, so
    // anything but a number (with an optional K/M/G quantifier) would be
    // Sieve source; fall back to 0.
    const raw = String((Array.isArray(value) ? value[0] : value) ?? '').trim();
    const sizeValue = /^\d+[KMG]?$/i.test(raw) ? raw : '0';
    const op = comparator === 'greater_than' ? ':over' : ':under';
    return `size ${op} ${sizeValue}`;
  }

  const values = toValueList(value);

  if (field === 'body') {
    switch (comparator) {
      case 'not_contains':
        return `not body :contains ${formatStringArg(values)}`;
      case 'is':
        return `body :is ${formatStringArg(values)}`;
      case 'not_is':
        return `not body :is ${formatStringArg(values)}`;
      case 'starts_with':
        return `body :matches ${formatStringArg(values, (v) => `${v}*`)}`;
      case 'ends_with':
        return `body :matches ${formatStringArg(values, (v) => `*${v}`)}`;
      case 'matches':
        return `body :matches ${formatStringArg(values)}`;
      case 'regex':
        return `body :regex ${formatStringArg(values)}`;
      default:
        return `body :contains ${formatStringArg(values)}`;
    }
  }

  if (field === 'delivered_to') {
    // RFC 5228 §5.4: the envelope recipient, which a To or Cc header does
    // not have to name (Bcc, lists, aliases).
    switch (comparator) {
      case 'address_is':
        return `envelope :is "to" ${formatStringArg(values)}`;
      case 'domain_is':
        return `envelope :domain :is "to" ${formatStringArg(values)}`;
      default:
        return `envelope :contains "to" ${formatStringArg(values)}`;
    }
  }

  if (field === 'attachment') {
    // RFC 5703: :mime :anychild matches against headers of any MIME part.
    // has_any tests Content-Disposition for "attachment"; has_type matches
    // the file extension against the filename across BOTH Content-Disposition
    // (filename= parameter) and Content-Type (name= parameter) - many older
    // senders (Microsoft SMTPSVC, PrintToMail, etc.) put the filename only
    // in Content-Type and leave Content-Disposition without a filename.
    // RFC 5228 §5.7 allows a string-list for header names; the test passes
    // if any listed header matches. Wildcard "*.<ext>*" catches quoted,
    // unquoted, and RFC-2231-encoded forms alike since ".<ext>" appears as
    // a literal substring in all of them.
    // Multiple extensions become a Sieve value-list ["*.pdf*", "*.xml*"]
    // = OR within the condition (any item matches → test passes).
    if (comparator === 'has_any') {
      return `header :mime :anychild :contains "Content-Disposition" "attachment"`;
    }
    const normalised = values.map((v) => v.replace(/^[.*]+/, '').trim()).filter(Boolean);
    return `header :mime :anychild :matches ["Content-Disposition", "Content-Type"] ${formatStringArg(normalised, (ext) => `*.${ext}*`)}`;
  }

  const headerName = escapeString(conditionHeaderName(condition));

  // RFC 5228 §5.1: `address` compares the parsed address, so the display
  // name and the angle brackets play no part. `header :contains` would let
  // "anna@acme.com" match joanna@acme.com, and `header :matches "*@acme.com"`
  // never matches "Anna <anna@acme.com>" because of the closing ">".
  if ((comparator === 'address_is' || comparator === 'domain_is') && ADDRESS_FIELDS.has(field)) {
    const part = comparator === 'domain_is' ? ':domain ' : '';
    return `address ${part}:is "${headerName}" ${formatStringArg(values)}`;
  }

  switch (comparator) {
    case 'contains':
      return `header :contains "${headerName}" ${formatStringArg(values)}`;
    case 'not_contains':
      return `not header :contains "${headerName}" ${formatStringArg(values)}`;
    case 'is':
      return `header :is "${headerName}" ${formatStringArg(values)}`;
    case 'not_is':
      return `not header :is "${headerName}" ${formatStringArg(values)}`;
    case 'starts_with':
      return `header :matches "${headerName}" ${formatStringArg(values, (v) => `${v}*`)}`;
    case 'ends_with':
      return `header :matches "${headerName}" ${formatStringArg(values, (v) => `*${v}`)}`;
    case 'matches':
      return `header :matches "${headerName}" ${formatStringArg(values)}`;
    case 'regex':
      return `header :regex "${headerName}" ${formatStringArg(values)}`;
    default:
      return `header :contains "${headerName}" ${formatStringArg(values)}`;
  }
}

const FLAG_ACTIONS = new Set<FilterAction['type']>(['mark_read', 'star', 'add_label']);

function fileintoTarget(action: FilterAction, useMailboxId: boolean): string {
  const path = `"${escapeString(action.value || '')}"`;
  // RFC 9042: the path is the fallback when the id no longer exists.
  return useMailboxId && action.mailboxId
    ? `:mailboxid "${escapeString(action.mailboxId)}" ${path}`
    : path;
}

function generateActions(actions: FilterAction[], useMailboxId: boolean): string[] {
  // fileinto (and the implicit keep) store the flags set at that moment, so a
  // flag action placed after a move in the UI would be lost. Set flags first.
  const ordered = [
    ...actions.filter(a => FLAG_ACTIONS.has(a.type)),
    ...actions.filter(a => !FLAG_ACTIONS.has(a.type)),
  ];
  return ordered.map(action => {
    switch (action.type) {
      case 'move':
        return `fileinto ${fileintoTarget(action, useMailboxId)};`;
      case 'copy':
        return `fileinto :copy ${fileintoTarget(action, useMailboxId)};`;
      case 'forward':
        return `redirect ${action.keepCopy ? ':copy ' : ''}"${escapeString(action.value || '')}";`;
      case 'mark_read':
        return 'addflag "\\\\Seen";';
      case 'star':
        return 'addflag "\\\\Flagged";';
      case 'add_label':
        return `addflag "$label:${escapeString(action.value || '')}";`;
      case 'discard':
        return 'discard;';
      case 'reject':
        return `reject "${escapeString(action.value || '')}";`;
      case 'keep':
        // A bare `keep;` delivers to the "default place", which on Stalwart is
        // Junk for a message its spam filter has already classified, so an
        // allow-list rule made with "Keep" would change nothing. An explicit
        // `fileinto "INBOX"` is honored over the spam verdict (#1027), but
        // only from Stalwart 0.16.22; older versions still move it to Junk.
        return 'fileinto "INBOX";';
      case 'stop':
        return 'stop;';
    }
  });
}

// Stalwart maps its spam verdict to 100 % (0.16.0) or to a graded value where
// 50 % is the spam threshold (0.16.19+), so ">= 50" matches "is spam" on both.
const SPAM_GUARD = 'not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50"';
const SPAM_GUARD_REQUIRES = ['spamtestplus', 'relational', 'comparator-i;ascii-numeric'];

export function supportsSpamGuard(extensions: string[] | undefined): boolean {
  return ['spamtestplus', 'relational'].every(e => extensions?.includes(e));
}

/**
 * A folder move takes a message out of the Junk folder the server would have
 * put it in, so move/copy rules skip spam unless the rule opts in. "Keep"
 * rules are allow-lists and stay unguarded.
 */
function needsSpamGuard(rule: FilterRule, extensions: string[] | undefined): boolean {
  return !rule.includeSpam &&
    rule.actions.some(a => a.type === 'move' || a.type === 'copy') &&
    supportsSpamGuard(extensions);
}

function computeRequires(
  rules: FilterRule[],
  vacation: VacationSieveConfig | undefined,
  useMailboxId: boolean,
  serverExtensions: string[] | undefined,
): string[] {
  const extensions = new Set<string>();
  const enabledRules = rules.filter(r => r.enabled);

  if (vacation?.isEnabled) {
    extensions.add('vacation');
  }

  for (const rule of enabledRules) {
    if (needsSpamGuard(rule, serverExtensions)) {
      for (const e of SPAM_GUARD_REQUIRES) extensions.add(e);
    }
    if (periodTests(rule)?.length) {
      for (const e of PERIOD_REQUIRES) extensions.add(e);
    }
    for (const condition of rule.conditions) {
      if (condition.field === 'body') extensions.add('body');
      if (condition.field === 'attachment') extensions.add('mime');
      if (condition.field === 'delivered_to') extensions.add('envelope');
      if (usesRegex(condition)) extensions.add('regex');
    }
    for (const action of rule.actions) {
      switch (action.type) {
        case 'move':
        case 'copy':
          extensions.add('fileinto');
          if (action.type === 'copy') extensions.add('copy');
          if (useMailboxId && action.mailboxId) {
            // Stalwart rejects :mailboxid unless "mailbox" is declared too.
            extensions.add('mailbox');
            extensions.add('mailboxid');
          }
          break;
        case 'keep':
          extensions.add('fileinto');
          break;
        case 'forward':
          if (action.keepCopy) extensions.add('copy');
          break;
        case 'mark_read':
        case 'star':
        case 'add_label':
          extensions.add('imap4flags');
          break;
        case 'reject':
          extensions.add('reject');
          break;
      }
    }
  }

  return [...extensions];
}

function stripRuleForMetadata(r: FilterRule): Omit<FilterRule, 'origin' | 'originLabel' | 'rawBlock'> {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    matchType: r.matchType,
    conditions: r.conditions,
    actions: r.actions,
    stopProcessing: r.stopProcessing,
    ...(r.includeSpam ? { includeSpam: true } : {}),
    ...(r.activeFrom !== undefined ? { activeFrom: r.activeFrom } : {}),
    ...(r.activeUntil !== undefined ? { activeUntil: r.activeUntil } : {}),
  };
}

export interface GenerateOptions {
  /**
   * Require extensions used by external (non-Bulwark) rules that we must
   * preserve in the top-level `require` directive. Duplicates with Bulwark's
   * own requires are deduplicated.
   */
  externalRequires?: string[];
  /**
   * Run the server's vacation script (VacationResponse) from this one. Only
   * one script can be active, so this keeps the auto-reply working while the
   * filters stay active.
   */
  includeVacation?: boolean;
  /**
   * The server's vacation script for `includeVacation`: "vacation" unless
   * the server keeps Stalwart 1.2's "managed" (see findServerVacationScript).
   */
  vacationScriptName?: string;
  /**
   * Forwarding from the vacation card. Always kept in the metadata; it runs
   * while it is switched on, with or without the auto-reply.
   */
  vacationForward?: VacationForward | null;
  /**
   * Who gets the auto-reply when not everyone should. Always kept in the
   * metadata; it narrows the vacation include (`includeVacation`) while the
   * auto-reply is on, and within its period where it carries one.
   */
  vacationAudience?: VacationAudience | null;
  /**
   * The auto-reply is off. An include that stays then (the one of "managed",
   * which also runs the server's own rules and sender lists) is written for
   * every sender; the audience waits in the metadata.
   */
  vacationAudienceIdle?: boolean;
  /**
   * The server's `sieveExtensions`. Folder moves use `:mailboxid` when it
   * lists "mailboxid"; without it they target the folder path only.
   */
  extensions?: string[];
  /**
   * The server rules region as parsed (see lib/sieve/server-rules). Written
   * back first after `require`, ahead of the vacation include and the rules.
   */
  serverRules?: string;
}

/** Name of the script a server builds for VacationResponse (RFC 9661). */
export const VACATION_SCRIPT_NAME = 'vacation';
/** The script Bulwark creates for the filters. */
export const FILTERS_SCRIPT_NAME = 'filters';

/**
 * Stalwart 1.2 and later keep the auto-reply, together with the server's own
 * mail rules, in one read-only script of this name, compared without case.
 * Like the "vacation" script before, VacationResponse/set activates it, which
 * switches the filters off, unless the active script includes it; then it
 * only changes the auto-reply.
 */
export const MANAGED_SCRIPT_NAME = 'managed';

/** Stalwart 1.2's "managed" script, compared without case as Stalwart does. */
export function isManagedScriptName(name: string): boolean {
  return name.toLowerCase() === MANAGED_SCRIPT_NAME;
}

/** A script the server writes for VacationResponse; nothing else may change it. */
export function isServerVacationScript(name: string): boolean {
  return name === VACATION_SCRIPT_NAME || isManagedScriptName(name);
}

/**
 * The script the server runs the auto-reply from: "managed" where the server
 * keeps one, else "vacation". Next to "managed", a "vacation" script is one
 * from before Stalwart 1.2, which the server no longer writes.
 */
export function findServerVacationScript<T extends { name: string }>(scripts: readonly T[]): T | undefined {
  return scripts.find(s => isManagedScriptName(s.name)) ?? scripts.find(s => s.name === VACATION_SCRIPT_NAME);
}

export function generateScript(
  rules: FilterRule[],
  vacation?: VacationSieveConfig,
  options: GenerateOptions = {},
): string {
  // Partition rules by origin. Treat missing origin as 'bulwark' for back-compat.
  const bulwarkRules: FilterRule[] = [];
  const externalRules: FilterRule[] = [];
  for (const r of rules) {
    if (r.origin && r.origin !== 'bulwark') externalRules.push(r);
    else bulwarkRules.push(r);
  }

  const metadata: FilterMetadata = {
    version: 1,
    rules: bulwarkRules.map(stripRuleForMetadata) as FilterRule[],
  };
  if (vacation?.isEnabled) {
    metadata.vacation = vacation;
  }
  if (options.includeVacation) {
    metadata.includeVacation = true;
  }
  if (options.vacationForward) {
    if (isValidVacationForward(options.vacationForward)) {
      metadata.vacationForward = normalizeVacationForward(options.vacationForward);
    } else {
      debug.warn('filters', 'Dropping unusable vacation forwarding');
    }
  }
  if (options.vacationAudience) {
    if (isValidVacationAudience(options.vacationAudience)) {
      metadata.vacationAudience = normalizeVacationAudience(options.vacationAudience);
    } else {
      debug.warn('filters', 'Dropping unusable vacation audience');
    }
  }
  // An older build would take a version 1 script as its own and write it back
  // without what it does not know: a rule without its period forwards for
  // good, the auto-reply goes to everyone. It leaves version 2 alone. A
  // forward that is off only loses its remembered address that way, so it
  // stays version 1: the native app still edits version 1 only. A regex
  // condition would come back from those as a plain "contains", and one on
  // "Delivered to" would make their save fail.
  if (
    metadata.rules.some(hasPeriod) ||
    metadata.rules.some(r => r.conditions.some(c => usesRegex(c) || c.field === 'delivered_to')) ||
    metadata.vacationForward?.enabled ||
    metadata.vacationAudience
  ) {
    metadata.version = 2;
  }
  // The JSON sits inside a /* ... */ comment: a "*/" in any string (a rule
  // name, a condition value) would end the comment and turn the rest into
  // live Sieve. JSON reads "\/" back as "/", so the metadata is unchanged.
  const metadataJson = JSON.stringify(metadata).replace(/\*\//g, '*\\/');
  const lines: string[] = [];

  lines.push('/* @metadata:begin');
  lines.push(metadataJson);
  lines.push('@metadata:end */');
  lines.push('');

  const useMailboxId = options.extensions?.includes('mailboxid') ?? false;
  const bulwarkRequires = computeRequires(bulwarkRules, vacation, useMailboxId, options.extensions);
  // The audience narrows the include only while the auto-reply is on.
  const audience = options.includeVacation && !options.vacationAudienceIdle ? metadata.vacationAudience : undefined;
  // Outside the period the audience carries, the include runs for every
  // sender. A period the server cannot test leaves the include narrowed
  // throughout: that answers nobody else.
  const audiencePeriod = audience && supportsPeriods(options.extensions) ? periodTests(audience) : null;
  if (options.includeVacation) bulwarkRequires.push('include');
  if (audience) bulwarkRequires.push('envelope');
  if (audiencePeriod?.length) bulwarkRequires.push(...PERIOD_REQUIRES);
  const serverRules = options.serverRules?.trim() ?? '';
  if (/\binclude\b/.test(serverRules)) bulwarkRequires.push('include');

  // Forwarding from the vacation card runs whenever it is switched on, with
  // or without the auto-reply, ahead of every rule. A period it cannot read
  // would let it forward for good, so then it does not run.
  const forward = metadata.vacationForward?.enabled ? metadata.vacationForward : null;
  const forwardPeriod = forward ? periodTests(forward) : null;
  const forwardSpamGuard = supportsSpamGuard(options.extensions);
  if (forward && forwardPeriod) {
    if (forward.keepCopy) bulwarkRequires.push('copy');
    if (forwardPeriod.length > 0) bulwarkRequires.push(...PERIOD_REQUIRES);
    if (forwardSpamGuard) bulwarkRequires.push(...SPAM_GUARD_REQUIRES);
  }
  const externalRequires = options.externalRequires ?? [];
  const allRequires = [...new Set([...bulwarkRequires, ...externalRequires])].sort();

  if (allRequires.length > 0) {
    lines.push(`require [${allRequires.map(r => `"${r}"`).join(', ')}];`);
  }

  if (serverRules) {
    lines.push('');
    lines.push(...renderServerRules(serverRules));
  }

  if (options.includeVacation) {
    // The "# Vacation auto-reply" comment marks the block as Bulwark's, so
    // the parser does not re-import it as an external rule.
    lines.push('');
    lines.push('# Vacation auto-reply');
    // Stalwart 1.2 counts "managed" as included only through a literal name
    // without :global, as written here.
    const include = `include :personal :optional "${escapeString(options.vacationScriptName ?? VACATION_SCRIPT_NAME)}";`;
    if (audience) {
      // Only senders from (or not from) the account's own domains. The reply
      // goes to the envelope sender, so that is the address to judge: a From
      // header can name a colleague on mail from anywhere, and the reply
      // meant for colleagues would go to whoever sent it.
      const domains = audience.domains.map(d => `"${escapeString(d)}"`).join(', ');
      const senders = `${audience.only === 'external' ? 'not ' : ''}envelope :domain :is "from" [${domains}]`;
      if (audiencePeriod?.length) {
        const during = audiencePeriod.length === 1 ? audiencePeriod[0] : `allof(${audiencePeriod.join(', ')})`;
        lines.push(`if anyof(${senders}, not ${during}) {`);
      } else {
        lines.push(`if ${senders} {`);
      }
      lines.push(`    ${include}`);
      lines.push('}');
    } else {
      lines.push(include);
    }
  }

  if (vacation?.isEnabled) {
    lines.push('');
    lines.push('# Vacation auto-reply');
    const vacationParts: string[] = [];
    if (vacation.subject) {
      vacationParts.push(`:subject "${escapeString(vacation.subject)}"`);
    }
    vacationParts.push(`"${escapeString(vacation.textBody || '')}"`);
    lines.push(`vacation ${vacationParts.join(' ')};`);
  }

  if (forward && forwardPeriod) {
    // Spam is not passed on: it stays here for the server's own handling.
    const tests = [...forwardPeriod, ...(forwardSpamGuard ? [SPAM_GUARD] : [])];
    const condition = tests.length === 0 ? 'true' : tests.length === 1 ? tests[0] : `allof(${tests.join(', ')})`;
    lines.push('');
    lines.push(VACATION_FORWARD_MARKER);
    lines.push(`if ${condition} {`);
    lines.push(`    redirect ${forward.keepCopy ? ':copy ' : ''}"${escapeString(forward.to)}";`);
    // Without a copy kept here, no rule below may file it either.
    if (!forward.keepCopy) lines.push('    stop;');
    lines.push('}');
  }

  const enabledBulwarkRules = bulwarkRules.filter(r => r.enabled);

  for (const rule of enabledBulwarkRules) {
    if (rule.conditions.length === 0 || rule.actions.length === 0) {
      debug.warn('filters', `Skipping rule "${rule.name}": empty conditions or actions`);
      continue;
    }
    // The server would refuse the whole script, every other rule with it.
    // The rule stays in the metadata, so it can still be corrected.
    const badHeader = rule.conditions
      .filter(c => c.field === 'header')
      .map(conditionHeaderName)
      .find(name => !isValidSieveHeaderName(name));
    if (badHeader !== undefined) {
      debug.warn('filters', `Skipping rule "${rule.name}": invalid header name "${badHeader}"`);
      continue;
    }
    // Without its period a rule would act all the time - a forwarding rule
    // would forward for good - so one whose period is unusable is dropped.
    const period = periodTests(rule);
    if (period === null) {
      debug.warn('filters', `Skipping rule "${rule.name}": unusable period`);
      continue;
    }

    lines.push('');
    // A line break in the name would end the comment and start a command.
    lines.push(`# Rule: ${rule.name.replace(/\s+/g, ' ')}`);

    const conditions = rule.conditions.map(generateCondition);
    let conditionStr: string;

    if (conditions.length === 0) {
      conditionStr = 'true';
    } else if (conditions.length === 1) {
      conditionStr = conditions[0];
    } else {
      const wrapper = rule.matchType === 'all' ? 'allof' : 'anyof';
      conditionStr = `${wrapper}(${conditions.join(', ')})`;
    }

    if (needsSpamGuard(rule, options.extensions)) {
      conditionStr = conditions.length > 1 && rule.matchType === 'all'
        ? `allof(${conditions.join(', ')}, ${SPAM_GUARD})`
        : `allof(${conditionStr}, ${SPAM_GUARD})`;
    }

    // The period comes first: outside it, nothing else is evaluated.
    if (period.length > 0) {
      conditionStr = `allof(${[...period, conditionStr].join(', ')})`;
    }

    const actionLines = generateActions(rule.actions, useMailboxId);

    // discard and reject only cancel the implicit keep (RFC 5228 4.4,
    // RFC 5429); the script goes on, and the rules below would still act on
    // the message. So "stop processing" always writes a stop, unless the
    // block has one already: it runs straight through, so any stop in it ends
    // the script.
    if (rule.stopProcessing && !actionLines.includes('stop;')) {
      actionLines.push('stop;');
    }

    lines.push(`if ${conditionStr} {`);
    for (const actionLine of actionLines) {
      lines.push(`    ${actionLine}`);
    }
    lines.push('}');
  }

  // Append preserved external rules verbatim. Each rawBlock carries its own
  // leading comments, but also the blank lines around it in the source
  // script; trim those and put exactly one blank line between blocks, so a
  // save writes the same script as the one before it.
  const externalBlocks = externalRules
    .map((ext) => (ext.rawBlock ?? '').trim())
    .filter((block) => block.length > 0);
  if (externalBlocks.length > 0) {
    lines.push('');
    lines.push('# --- External rules (managed outside Bulwark) ---');
    lines.push(externalBlocks.join('\n\n'));
  }

  lines.push('');
  return lines.join('\n');
}
