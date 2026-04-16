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

function generateCondition(condition: FilterCondition): string {
  const { field, comparator, value } = condition;

  if (field === 'size') {
    const op = comparator === 'greater_than' ? ':over' : ':under';
    return `size ${op} ${value}`;
  }

  if (field === 'body') {
    const matchType = comparator === 'is' ? ':is' : ':contains';
    return `body ${matchType} "${escapeString(value)}"`;
  }

  const headerName = field === 'header'
    ? (condition.headerName || 'X-Unknown')
    : HEADER_MAP[field];

  const escaped = escapeString(value);

  switch (comparator) {
    case 'contains':
      return `header :contains "${headerName}" "${escaped}"`;
    case 'not_contains':
      return `not header :contains "${headerName}" "${escaped}"`;
    case 'is':
      return `header :is "${headerName}" "${escaped}"`;
    case 'not_is':
      return `not header :is "${headerName}" "${escaped}"`;
    case 'starts_with':
      return `header :matches "${headerName}" "${escaped}*"`;
    case 'ends_with':
      return `header :matches "${headerName}" "*${escaped}"`;
    case 'matches':
      return `header :matches "${headerName}" "${escaped}"`;
    default:
      return `header :contains "${headerName}" "${escaped}"`;
  }
}

function generateActions(actions: FilterAction[]): string[] {
  return actions.map(action => {
    switch (action.type) {
      case 'move':
        return `fileinto "${escapeString(action.value || '')}";`;
      case 'copy':
        return `fileinto :copy "${escapeString(action.value || '')}";`;
      case 'forward':
        return `redirect "${escapeString(action.value || '')}";`;
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
        return 'keep;';
      case 'stop':
        return 'stop;';
    }
  });
}

function computeRequires(rules: FilterRule[], vacation?: VacationSieveConfig): string[] {
  const extensions = new Set<string>();
  const enabledRules = rules.filter(r => r.enabled);

  if (vacation?.isEnabled) {
    extensions.add('vacation');
  }

  for (const rule of enabledRules) {
    for (const condition of rule.conditions) {
      if (condition.field === 'body') extensions.add('body');
    }
    for (const action of rule.actions) {
      switch (action.type) {
        case 'move':
          extensions.add('fileinto');
          break;
        case 'copy':
          extensions.add('fileinto');
          extensions.add('copy');
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
  };
}

export interface GenerateOptions {
  /**
   * Require extensions used by external (non-Bulwark) rules that we must
   * preserve in the top-level `require` directive. Duplicates with Bulwark's
   * own requires are deduplicated.
   */
  externalRequires?: string[];
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
  const metadataJson = JSON.stringify(metadata);
  const lines: string[] = [];

  lines.push('/* @metadata:begin');
  lines.push(metadataJson);
  lines.push('@metadata:end */');
  lines.push('');

  const bulwarkRequires = computeRequires(bulwarkRules, vacation);
  const externalRequires = options.externalRequires ?? [];
  const allRequires = [...new Set([...bulwarkRequires, ...externalRequires])].sort();

  if (allRequires.length > 0) {
    lines.push(`require [${allRequires.map(r => `"${r}"`).join(', ')}];`);
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
    lines.push(`# Rule: ${rule.name}`);

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

    const actionLines = generateActions(rule.actions);

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
