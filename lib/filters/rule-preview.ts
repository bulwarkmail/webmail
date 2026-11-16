import type { FilterCondition, FilterRule } from '@/lib/jmap/sieve-types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { EmailAddress, Mailbox } from '@/lib/jmap/types';
import { isPeriodBoundary } from '@/lib/sieve/period';
import { retroProperties, ruleMatches, toRetroMessage } from './retroactive';
import { sizeInBytes } from './rule-editor-model';

export interface RulePreviewItem {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
}

export interface RulePreview {
  items: RulePreviewItem[];
  total: number;
  complete: boolean;
  inFolder?: number;
}

export interface RulePreviewTarget {
  client: Pick<IJMAPClient, 'queryEmailFields'>;
  accountId: string;
  mailboxes: Mailbox[];
}

export interface MatchOptions {
  folderId?: string;
  skipJunk?: boolean;
}

type Verify = { matchType: 'all' | 'any'; conditions: FilterCondition[] } | null;

export interface Probe {
  filter: Record<string, unknown>;
  verify: Verify;
  scan: boolean;
  covered: boolean;
}

export interface PreviewPlan {
  probes: Probe[];
  properties: string[];
  excluded: string[];
}

export interface RuleMatches {
  records: Record<string, unknown>[];
  complete: boolean;
}

export const PREVIEW_SCAN = 1000;
export const PREVIEW_SHOWN = 50;
/** Folders whose mail is never previewed or sorted: it was not received, or is on its way out. */
export const NOT_RECEIVED = new Set(['trash', 'junk', 'sent', 'drafts']);
const HEADER_COMPARATORS = new Set<FilterCondition['comparator']>([
  'contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'matches', 'address_is', 'domain_is',
]);
const WORD_SEARCH = new Set<FilterCondition['comparator']>(['contains', 'is', 'starts_with', 'ends_with']);
const EXACT_SEARCH = new Set<FilterCondition['comparator']>(['address_is', 'domain_is']);
const SEARCH_FIELD: Partial<Record<FilterCondition['field'], string>> = {
  from: 'from', to: 'to', cc: 'cc', subject: 'subject',
};

interface ServerCondition { kind: 'server'; filter: Record<string, unknown> | null }
interface ClientCondition { kind: 'client'; condition: FilterCondition; narrow: Record<string, unknown> | null; exact: boolean }
type Planned = ServerCondition | ClientCondition;

function values(condition: FilterCondition): string[] {
  const list = Array.isArray(condition.value) ? condition.value : [condition.value];
  return list.map((v) => v.trim()).filter(Boolean);
}

function anyOf(parts: Record<string, unknown>[]): Record<string, unknown> {
  return parts.length === 1 ? parts[0] : { operator: 'OR', conditions: parts };
}

function allOf(parts: Record<string, unknown>[]): Record<string, unknown> {
  return parts.length === 1 ? parts[0] : { operator: 'AND', conditions: parts };
}

function planCondition(condition: FilterCondition): Planned | null {
  const { field, comparator } = condition;
  if (field === 'all') return { kind: 'server', filter: null };
  // The envelope recipient is gone once the mail is delivered; a
  // Delivered-To header would only be a guess at it.
  if (field === 'delivered_to') return null;
  if (field === 'size') {
    const bytes = sizeInBytes(values(condition)[0] ?? '');
    if (bytes === null) return null;
    return { kind: 'server', filter: comparator === 'greater_than' ? { minSize: bytes + 1 } : { maxSize: bytes } };
  }
  if (field === 'attachment') {
    if (comparator === 'has_any') return { kind: 'client', condition, narrow: { hasAttachment: true }, exact: true };
    return attachmentTypes(condition).length > 0 ? { kind: 'client', condition, narrow: null, exact: false } : null;
  }
  if (field === 'body') {
    if (comparator !== 'contains' && comparator !== 'is' && comparator !== 'not_contains') return null;
    const list = values(condition);
    if (list.length === 0) return null;
    const positive = anyOf(list.map((v) => ({ body: v })));
    return { kind: 'server', filter: comparator === 'not_contains' ? { operator: 'NOT', conditions: [positive] } : positive };
  }
  if (!HEADER_COMPARATORS.has(comparator)) return null;
  if (field === 'header' && !condition.headerName?.trim()) return null;
  const searchField = SEARCH_FIELD[field];
  const list = values(condition);
  if (list.length === 0) return null;
  const exact = EXACT_SEARCH.has(comparator) && (field === 'from' || field === 'to' || field === 'cc');
  const searchable = searchField && (exact || WORD_SEARCH.has(comparator));
  return {
    kind: 'client',
    condition,
    narrow: searchable ? anyOf(list.map((v) => ({ [searchField]: v }))) : null,
    exact,
  };
}

function attachmentTypes(condition: FilterCondition): string[] {
  return values(condition).map((v) => v.replace(/^[.*]+/, '').trim().toLowerCase()).filter(Boolean);
}

function attachmentMatches(condition: FilterCondition, record: Record<string, unknown>): boolean {
  const parts = Array.isArray(record.attachments) ? (record.attachments as { name?: string | null; disposition?: string | null }[]) : [];
  if (condition.comparator === 'has_any') return parts.some((p) => (p.disposition ?? '').toLowerCase().includes('attachment'));
  const types = attachmentTypes(condition);
  return parts.some((p) => types.some((t) => (p.name ?? '').toLowerCase().includes(`.${t}`)));
}

function excludedMailboxes(mailboxes: Mailbox[]): string[] {
  return mailboxes.filter((m) => m.role && NOT_RECEIVED.has(m.role)).map((m) => m.originalId || m.id);
}

function utcSeconds(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function scopeFilters(rule: FilterRule, mailboxes: Mailbox[], folderId?: string): Record<string, unknown>[] {
  const serverId = (m: Mailbox) => m.originalId || m.id;
  const parts: Record<string, unknown>[] = [];
  if (folderId) {
    const folder = mailboxes.find((m) => m.id === folderId);
    parts.push({ inMailbox: folder ? serverId(folder) : folderId });
  }
  // Mail in Sent, Drafts, Trash or Spam is left out, also when it is in the
  // chosen folder too, or the chosen folder is one of them.
  const excluded = excludedMailboxes(mailboxes);
  if (excluded.length > 0) parts.push({ operator: 'NOT', conditions: excluded.map((id) => ({ inMailbox: id })) });
  if (isPeriodBoundary(rule.activeFrom)) parts.push({ after: utcSeconds(Date.parse(rule.activeFrom)) });
  if (isPeriodBoundary(rule.activeUntil)) parts.push({ before: utcSeconds(Date.parse(rule.activeUntil) + 1000) });
  return parts;
}

export function previewPlan(rule: FilterRule, mailboxes: Mailbox[], folderId?: string): PreviewPlan | null {
  if (rule.conditions.length === 0) return null;
  const planned: Planned[] = [];
  for (const condition of rule.conditions) {
    const plan = planCondition(condition);
    if (!plan) return null;
    planned.push(plan);
  }
  const scope = scopeFilters(rule, mailboxes, folderId);
  const within = (parts: Record<string, unknown>[]) => allOf([...scope, ...parts].length > 0 ? [...scope, ...parts] : [{}]);
  const server = planned.filter((p): p is ServerCondition => p.kind === 'server');
  const client = planned.filter((p): p is ClientCondition => p.kind === 'client');
  const serverFilters = server.map((s) => s.filter).filter((f): f is Record<string, unknown> => f !== null);
  const clientConditions = client.map((c) => c.condition);
  const probes: Probe[] = [];

  if (rule.matchType === 'any') {
    const everything = server.some((s) => s.filter === null);
    if (everything) {
      probes.push({ filter: within([]), verify: null, scan: false, covered: false });
    } else {
      if (serverFilters.length > 0) probes.push({ filter: within([anyOf(serverFilters)]), verify: null, scan: false, covered: false });
      if (client.length > 0) {
        const verify: Verify = { matchType: 'any', conditions: clientConditions };
        const scan = !client.every((c) => c.exact);
        if (client.every((c) => c.narrow)) {
          probes.push({ filter: within([anyOf(client.map((c) => c.narrow!))]), verify, scan: false, covered: scan });
        }
        if (scan) probes.push({ filter: within([]), verify, scan: true, covered: false });
      }
    }
  } else {
    const verify: Verify = client.length > 0 ? { matchType: 'all', conditions: clientConditions } : null;
    const exact = client.filter((c) => c.exact).map((c) => c.narrow!);
    const words = client.filter((c) => !c.exact && c.narrow).map((c) => c.narrow!);
    if (client.length === 0 || exact.length > 0) {
      probes.push({ filter: within([...serverFilters, ...exact]), verify, scan: false, covered: false });
    } else {
      if (words.length > 0) probes.push({ filter: within([...serverFilters, ...words]), verify, scan: false, covered: true });
      probes.push({ filter: within(serverFilters), verify, scan: true, covered: false });
    }
  }

  const properties = new Set(['from', 'subject', 'receivedAt', 'mailboxIds', 'keywords']);
  for (const p of retroProperties({ ...rule, conditions: clientConditions.filter((c) => c.field !== 'attachment') })) properties.add(p);
  if (clientConditions.some((c) => c.field === 'attachment')) properties.add('attachments');
  return { probes, properties: [...properties], excluded: excludedMailboxes(mailboxes) };
}

function verifies(rule: FilterRule, plan: PreviewPlan, verify: Verify, record: Record<string, unknown>, skipJunk: boolean): boolean {
  if (skipJunk && (record.keywords as Record<string, boolean> | undefined)?.$junk) return false;
  const boxes = (record.mailboxIds as Record<string, boolean> | undefined) ?? {};
  if (plan.excluded.some((id) => boxes[id])) return false;
  if (!verify) return true;
  const message = toRetroMessage(record);
  const single = (condition: FilterCondition): FilterRule => ({
    ...rule, matchType: 'all', conditions: [condition], actions: [], includeSpam: true,
  });
  const results = verify.conditions.map((c) => (c.field === 'attachment' ? attachmentMatches(c, record) : ruleMatches(single(c), message)));
  return verify.matchType === 'any' ? results.some(Boolean) : results.every(Boolean);
}

export async function findRuleMatches(
  target: RulePreviewTarget,
  rule: FilterRule,
  options: MatchOptions & { limit: number },
): Promise<RuleMatches | null> {
  const plan = previewPlan(rule, target.mailboxes, options.folderId);
  if (!plan) return null;
  const answers = await Promise.all(plan.probes.map((probe) =>
    target.client.queryEmailFields(probe.filter, plan.properties, target.accountId, options.limit)
      .then((records) => ({ probe, records }))));
  const found = new Map<string, Record<string, unknown>>();
  let complete = true;
  for (const { probe, records } of answers) {
    if (records.length >= options.limit && !probe.covered) complete = false;
    for (const record of records) {
      const id = String(record.id);
      if (!found.has(id) && verifies(rule, plan, probe.verify, record, !!options.skipJunk)) found.set(id, record);
    }
  }
  const time = (r: Record<string, unknown>) => (typeof r.receivedAt === 'string' ? Date.parse(r.receivedAt) : 0);
  return { records: [...found.values()].sort((a, b) => time(b) - time(a)), complete };
}

function senderLabel(from: unknown): string {
  const first = (Array.isArray(from) ? from[0] : null) as EmailAddress | null;
  return first?.name?.trim() || first?.email || '';
}

export async function previewRule(target: RulePreviewTarget, rule: FilterRule, options: MatchOptions = {}): Promise<RulePreview | null> {
  const matches = await findRuleMatches(target, rule, { skipJunk: options.skipJunk, limit: PREVIEW_SCAN });
  if (!matches) return null;
  const folder = options.folderId ? target.mailboxes.find((m) => m.id === options.folderId) : undefined;
  const folderServerId = folder ? folder.originalId || folder.id : options.folderId;
  return {
    items: matches.records.slice(0, PREVIEW_SHOWN).map((r) => ({
      id: String(r.id),
      from: senderLabel(r.from),
      subject: typeof r.subject === 'string' ? r.subject : '',
      receivedAt: typeof r.receivedAt === 'string' ? r.receivedAt : '',
    })),
    total: matches.records.length,
    complete: matches.complete,
    ...(folderServerId
      ? { inFolder: matches.records.filter((r) => (r.mailboxIds as Record<string, boolean> | undefined)?.[folderServerId]).length }
      : {}),
  };
}
