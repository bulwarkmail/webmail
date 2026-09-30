import type { FilterRule, FilterCondition, FilterAction, FilterMetadata, VacationSieveConfig } from '@/lib/jmap/sieve-types';
import { debug } from '@/lib/debug';

const HEADER_MAP: Record<string, string> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  subject: 'Subject',
};

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
    const matchType = comparator === 'is' ? ':is' : ':contains';
    return `body ${matchType} ${formatStringArg(values)}`;
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

  const headerName = escapeString(field === 'header'
    ? (condition.headerName || 'X-Unknown')
    : HEADER_MAP[field]);

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

function supportsSpamGuard(extensions: string[] | undefined): boolean {
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
    for (const condition of rule.conditions) {
      if (condition.field === 'body') extensions.add('body');
      if (condition.field === 'attachment') extensions.add('mime');
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
   * Run the server-managed "vacation" script (VacationResponse) from this
   * one. Only one script can be active, so this keeps the auto-reply working
   * while the filters stay active.
   */
  includeVacation?: boolean;
  /**
   * The server's `sieveExtensions`. Folder moves use `:mailboxid` when it
   * lists "mailboxid"; without it they target the folder path only.
   */
  extensions?: string[];
}

/** Name of the script a server builds for VacationResponse (RFC 9661). */
export const VACATION_SCRIPT_NAME = 'vacation';

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
  if (options.includeVacation) bulwarkRequires.push('include');
  const externalRequires = options.externalRequires ?? [];
  const allRequires = [...new Set([...bulwarkRequires, ...externalRequires])].sort();

  if (allRequires.length > 0) {
    lines.push(`require [${allRequires.map(r => `"${r}"`).join(', ')}];`);
  }

  if (options.includeVacation) {
    // The "# Vacation auto-reply" comment marks the block as Bulwark's, so
    // the parser does not re-import it as an external rule.
    lines.push('');
    lines.push('# Vacation auto-reply');
    lines.push(`include :personal :optional "${VACATION_SCRIPT_NAME}";`);
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

  const enabledBulwarkRules = bulwarkRules.filter(r => r.enabled);

  for (const rule of enabledBulwarkRules) {
    if (rule.conditions.length === 0 || rule.actions.length === 0) {
      debug.warn('filters', `Skipping rule "${rule.name}": empty conditions or actions`);
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

    const actionLines = generateActions(rule.actions, useMailboxId);

    if (rule.stopProcessing) {
      const lastAction = rule.actions[rule.actions.length - 1];
      if (!lastAction || !['stop', 'discard', 'reject'].includes(lastAction.type)) {
        actionLines.push('stop;');
      }
    }

    lines.push(`if ${conditionStr} {`);
    for (const actionLine of actionLines) {
      lines.push(`    ${actionLine}`);
    }
    lines.push('}');
  }

  // Append preserved external rules verbatim. Each rawBlock already carries its
  // own leading comments and trailing whitespace from the source script.
  if (externalRules.length > 0) {
    lines.push('');
    lines.push('# --- External rules (managed outside Bulwark) ---');
    for (const ext of externalRules) {
      if (!ext.rawBlock) continue;
      lines.push(ext.rawBlock.replace(/\s+$/, ''));
    }
  }

  lines.push('');
  return lines.join('\n');
}
