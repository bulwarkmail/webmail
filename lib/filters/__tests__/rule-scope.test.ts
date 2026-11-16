import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { Mailbox } from '@/lib/jmap/types';
import type { QuickRuleTarget } from '../quick-rule-target';

const executePlan = vi.fn(async () => true);
vi.mock('../quick-rule-flow', () => ({ executePlan: (...args: unknown[]) => executePlan(...(args as [])) }));

const { appliesToExisting, applyRuleToScope, planMatched } = await import('../rule-scope');

function rule(overrides: Partial<FilterRule>): FilterRule {
  return {
    id: 'r',
    name: 'R',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'north' }],
    actions: [],
    stopProcessing: false,
    ...overrides,
  };
}

const mailboxes = [
  { id: 'inbox', role: 'inbox', name: 'Inbox' },
  { id: 'trash', role: 'trash', name: 'Trash' },
  { id: 'junk', role: 'junk', name: 'Junk' },
  { id: 'news', role: null, name: 'News' },
] as unknown as Mailbox[];

const unread = { id: 'u', mailboxIds: { inbox: true }, keywords: {} };
const read = { id: 'r', mailboxIds: { news: true }, keywords: { $seen: true, $flagged: true } };

describe('applying a rule to mail already received', () => {
  beforeEach(() => executePlan.mockClear());

  it('marks as read only what is unread and stars only what is not starred', () => {
    const plan = planMatched(rule({ actions: [{ type: 'mark_read' }, { type: 'star' }] }), [unread, read], mailboxes);
    expect(plan.steps).toEqual([
      { kind: 'mark_read', ids: ['u'] },
      { kind: 'keyword', ids: ['u'], keyword: '$flagged' },
    ]);
    expect(plan.ids).toEqual(['u']);
  });

  it('moves what is not in the folder yet and keeps a copy where the rule files one, as Sieve does', () => {
    const plan = planMatched(rule({ actions: [
      { type: 'move', value: 'News', mailboxId: 'news' },
      { type: 'copy', value: 'Inbox', mailboxId: 'inbox' },
    ] }), [unread, read], mailboxes);
    expect(plan.steps).toEqual([
      { kind: 'move', ids: ['u'], mailboxId: 'news' },
      { kind: 'copy', ids: ['u', 'r'], mailboxId: 'inbox' },
    ]);
  });

  it('sends deleted mail to the Trash, where it can still be recovered', () => {
    const plan = planMatched(rule({ actions: [{ type: 'discard' }] }), [unread], mailboxes);
    expect(plan.steps).toEqual([{ kind: 'move', ids: ['u'], mailboxId: 'trash' }]);
  });

  it('never forwards or bounces old mail', () => {
    const forwarding = rule({ actions: [{ type: 'forward', value: 'a@b.example' }, { type: 'reject', value: 'no' }] });
    expect(planMatched(forwarding, [unread], mailboxes).steps).toEqual([]);
    expect(appliesToExisting(forwarding)).toBe(false);
  });

  it('does not offer to apply a rule on the message text, which the server search cannot match exactly', () => {
    expect(appliesToExisting(rule({
      conditions: [{ field: 'body', comparator: 'contains', value: 'invoice' }],
      actions: [{ type: 'discard' }],
    }))).toBe(false);
  });

  it('can apply a rule that tags, files or deletes', () => {
    expect(appliesToExisting(rule({ actions: [{ type: 'add_label', value: 'work' }] }))).toBe(true);
    expect(appliesToExisting(rule({ actions: [{ type: 'move', value: 'News', mailboxId: 'news' }] }))).toBe(true);
    expect(appliesToExisting(rule({ actions: [{ type: 'discard' }] }))).toBe(true);
    expect(appliesToExisting(rule({ actions: [{ type: 'move', value: 'Gone' }] }))).toBe(false);
  });

  it('runs on every match in the chosen folder, including mail beyond the preview', async () => {
    const records = Array.from({ length: 1500 }, (_, i) => ({
      id: `m${i}`,
      mailboxIds: { inbox: true },
      keywords: {},
      'header:From:asAddresses:all': [[{ name: '', email: 'statements@northbank.example' }]],
    }));
    const queryEmailFields = vi.fn(async (_filter: unknown) => records);
    const target = { client: { queryEmailFields }, accountId: 'acc', mailboxes } as unknown as QuickRuleTarget;
    const count = await applyRuleToScope(target, rule({ actions: [{ type: 'mark_read' }] }), 'folder', 'inbox');
    expect(count).toBe(1500);
    expect(JSON.stringify(queryEmailFields.mock.calls[0][0])).toContain('"inMailbox":"inbox"');
    expect(executePlan).toHaveBeenCalledTimes(1);
  });

  it('goes through every match, however many there are', async () => {
    const records = Array.from({ length: 60000 }, (_, i) => ({
      id: `m${i}`, mailboxIds: { inbox: true }, keywords: {},
      'header:From:asAddresses:all': [[{ name: '', email: 'statements@northbank.example' }]],
    }));
    const queryEmailFields = vi.fn(async (_filter: unknown, _props: unknown, _account: unknown, limit: number) => records.slice(0, limit));
    const target = { client: { queryEmailFields }, accountId: 'acc', mailboxes } as unknown as QuickRuleTarget;
    expect(await applyRuleToScope(target, rule({ actions: [{ type: 'mark_read' }] }), 'all', null)).toBe(60000);
  });

  it('runs on all received mail when asked to', async () => {
    const queryEmailFields = vi.fn(async (_filter: unknown) => []);
    const target = { client: { queryEmailFields }, accountId: 'acc', mailboxes } as unknown as QuickRuleTarget;
    await applyRuleToScope(target, rule({ actions: [{ type: 'mark_read' }] }), 'all', 'inbox');
    expect(JSON.stringify(queryEmailFields.mock.calls[0][0])).toContain('"operator":"NOT"');
  });
});
