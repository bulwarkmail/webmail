import { describe, it, expect, vi } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { Mailbox } from '@/lib/jmap/types';
import { previewPlan, previewRule, PREVIEW_SCAN } from '../rule-preview';

function rule(overrides: Partial<FilterRule>): FilterRule {
  return {
    id: 'r',
    name: '',
    enabled: true,
    matchType: 'all',
    conditions: [],
    actions: [{ type: 'mark_read' }],
    stopProcessing: false,
    ...overrides,
  };
}

const mailboxes = [
  { id: 'inbox', role: 'inbox', name: 'Inbox' },
  { id: 'trash', role: 'trash', name: 'Trash' },
  { id: 'junk', role: 'junk', name: 'Junk' },
  { id: 'sent', role: 'sent', name: 'Sent' },
  { id: 'drafts', role: 'drafts', name: 'Drafts' },
  { id: 'news', role: null, name: 'Newsletters' },
] as unknown as Mailbox[];

const SCOPE = { operator: 'NOT', conditions: [{ inMailbox: 'trash' }, { inMailbox: 'junk' }, { inMailbox: 'sent' }, { inMailbox: 'drafts' }] };

function message(id: string, from: string, subject: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    from: [{ name: from.split('@')[0], email: from }],
    subject,
    receivedAt: `2026-11-${String(30 - Number(id.replace(/\D/g, '') || 0) % 28).padStart(2, '0')}T00:00:00Z`,
    mailboxIds: { inbox: true },
    keywords: {},
    'header:From:asAddresses:all': [[{ name: from.split('@')[0], email: from }]],
    'header:Subject:asText:all': [subject],
    'header:Subject:all': [` ${subject}`],
    ...extra,
  };
}

function server(answer: (filter: Record<string, unknown>) => Record<string, unknown>[]) {
  const queryEmailFields = vi.fn(async (filter: Record<string, unknown>) => answer(filter));
  return { target: { client: { queryEmailFields } as never, accountId: 'acc', mailboxes }, queryEmailFields };
}

const mentions = (filter: unknown, key: string): boolean => JSON.stringify(filter).includes(`"${key}"`);

describe('rule preview', () => {
  it('looks at received mail only: not Trash, Spam, Sent or Drafts', () => {
    const plan = previewPlan(rule({ conditions: [{ field: 'size', comparator: 'greater_than', value: '2M' }] }), mailboxes);
    expect(plan!.probes[0].filter).toEqual({ operator: 'AND', conditions: [SCOPE, { minSize: 2 * 1024 * 1024 + 1 }] });
  });

  it('leaves out a message that is also filed in Sent, even when the server returns it', async () => {
    const both = message('m1', 'a@b.example', 'x', { mailboxIds: { sent: true, news: true } });
    const { target } = server(() => [both, message('m2', 'a@b.example', 'y')]);
    const preview = await previewRule(target, rule({ conditions: [{ field: 'from', comparator: 'address_is', value: 'a@b.example' }] }));
    expect(preview!.items.map((i) => i.id)).toEqual(['m2']);
  });

  it('finds an exact sender with part of a subject word, which the word search alone would miss', async () => {
    const hit = message('m1', 'a@b.example', 'northbank statement');
    const { target } = server((filter) => (mentions(filter, 'subject') ? [] : [hit]));
    const preview = await previewRule(target, rule({ conditions: [
      { field: 'from', comparator: 'address_is', value: 'a@b.example' },
      { field: 'subject', comparator: 'contains', value: 'north' },
    ] }));
    expect(preview!.total).toBe(1);
  });

  it('checks attachments the way the rule does: by disposition and by file name', async () => {
    const pdf = message('m1', 'a@b.example', 'x', { attachments: [{ name: 'Statement.PDF', disposition: 'attachment' }] });
    const inline = message('m2', 'a@b.example', 'y', { attachments: [{ name: 'logo.png', disposition: 'inline' }] });
    const { target } = server(() => [pdf, inline]);
    const any = await previewRule(target, rule({ conditions: [{ field: 'attachment', comparator: 'has_any', value: '' }] }));
    expect(any!.items.map((i) => i.id)).toEqual(['m1']);
    const typed = await previewRule(target, rule({ conditions: [{ field: 'attachment', comparator: 'has_type', value: ['pdf', 'zip'] }] }));
    expect(typed!.items.map((i) => i.id)).toEqual(['m1']);
  });

  it('previews mail whose text does not contain a word', () => {
    const plan = previewPlan(rule({ conditions: [{ field: 'body', comparator: 'not_contains', value: 'unsubscribe' }] }), mailboxes);
    expect(plan!.probes[0].filter).toEqual({ operator: 'AND', conditions: [SCOPE, { operator: 'NOT', conditions: [{ body: 'unsubscribe' }] }] });
  });

  it('gives no preview for a body pattern the server search cannot run', () => {
    expect(previewPlan(rule({ conditions: [{ field: 'body', comparator: 'matches', value: 'x*' }] }), mailboxes)).toBeNull();
  });

  it('finds mail by part of a sender name, which the server word search misses', async () => {
    const northbank = message('m1', 'statements@northbank.example', 'Statement');
    const { target } = server((filter) => (mentions(filter, 'from') ? [] : [northbank, message('m2', 'x@other.example', 'Hi')]));
    const preview = await previewRule(target, rule({ conditions: [{ field: 'from', comparator: 'contains', value: 'north' }] }));
    expect(preview!.items.map((i) => i.id)).toEqual(['m1']);
    expect(preview!.total).toBe(1);
    expect(preview!.complete).toBe(true);
  });

  it('counts a message the word search and the scan both find once', async () => {
    const hit = message('m1', 'news@shop.example', 'Big sale');
    const { target } = server(() => [hit]);
    const preview = await previewRule(target, rule({ conditions: [{ field: 'subject', comparator: 'contains', value: 'sale' }] }));
    expect(preview!.total).toBe(1);
  });

  it('trusts the server for an exact sender address and does not scan', async () => {
    const { target, queryEmailFields } = server(() => [message('m1', 'a@b.example', 'x')]);
    await previewRule(target, rule({ conditions: [{ field: 'from', comparator: 'address_is', value: 'a@b.example' }] }));
    expect(queryEmailFields).toHaveBeenCalledTimes(1);
    expect(queryEmailFields.mock.calls[0][0]).toEqual({ operator: 'AND', conditions: [SCOPE, { from: 'a@b.example' }] });
  });

  it('says the count is a lower bound when the scan stopped before the oldest mail', async () => {
    const many = Array.from({ length: PREVIEW_SCAN }, (_, i) => message(`m${i}`, 'north@x.example', 'x'));
    const { target } = server((filter) => (mentions(filter, 'from') ? [] : many));
    const preview = await previewRule(target, rule({ conditions: [{ field: 'from', comparator: 'contains', value: 'north' }] }));
    expect(preview!.complete).toBe(false);
    expect(preview!.items.length).toBeLessThanOrEqual(50);
  });

  it('counts how many matches sit in the folder the rule could also be applied to', async () => {
    const { target } = server(() => [
      message('m1', 'a@news.example', 'x'),
      message('m2', 'a@news.example', 'y', { mailboxIds: { news: true } }),
    ]);
    const preview = await previewRule(target, rule({ conditions: [{ field: 'from', comparator: 'domain_is', value: 'news.example' }] }), { folderId: 'news' });
    expect(preview!.inFolder).toBe(1);
  });

  it('leaves out mail marked as spam when the rule files mail and does not include spam', async () => {
    const { target } = server(() => [message('m1', 'a@b.example', 'x', { keywords: { $junk: true } })]);
    const preview = await previewRule(target, rule({ conditions: [{ field: 'from', comparator: 'address_is', value: 'a@b.example' }] }), { skipJunk: true });
    expect(preview!.total).toBe(0);
  });

  it('only looks at mail received within the rule period', () => {
    const plan = previewPlan(rule({
      conditions: [{ field: 'attachment', comparator: 'has_any', value: '' }],
      activeFrom: '2026-01-01T00:00:00.000Z',
      activeUntil: '2026-02-01T00:00:00.000Z',
    }), mailboxes);
    expect(plan!.probes[0].filter).toEqual({
      operator: 'AND',
      conditions: [SCOPE, { after: '2026-01-01T00:00:00Z' }, { before: '2026-02-01T00:00:01Z' }, { hasAttachment: true }],
    });
    expect(plan!.properties).toContain('attachments');
  });

  it('with "any", keeps a body match even when its sender does not match', async () => {
    const bodyHit = message('m1', 'x@y.example', 'Nothing in the subject');
    const { target } = server((filter) => (mentions(filter, 'body') ? [bodyHit] : []));
    const preview = await previewRule(target, rule({
      matchType: 'any',
      conditions: [
        { field: 'from', comparator: 'contains', value: 'north' },
        { field: 'body', comparator: 'contains', value: 'statement' },
      ],
    }));
    expect(preview!.items.map((i) => i.id)).toEqual(['m1']);
  });

  it('with "any", does not take a fuzzy word-search hit on a header as a match', async () => {
    const stemmed = message('m1', 'x@y.example', 'invoice #1');
    const { target } = server((filter) => (mentions(filter, 'minSize') ? [] : [stemmed]));
    const preview = await previewRule(target, rule({
      matchType: 'any',
      conditions: [
        { field: 'subject', comparator: 'contains', value: 'invoices' },
        { field: 'size', comparator: 'greater_than', value: '50M' },
      ],
    }));
    expect(preview!.total).toBe(0);
  });

  it('gives no preview for "Delivered to", which delivered mail no longer has (#726)', () => {
    expect(previewPlan(rule({ conditions: [{ field: 'delivered_to', comparator: 'address_is', value: 'shop@example.com' }] }), mailboxes)).toBeNull();
    expect(previewPlan(rule({
      matchType: 'any',
      conditions: [
        { field: 'from', comparator: 'contains', value: 'shop' },
        { field: 'delivered_to', comparator: 'contains', value: 'shop' },
      ],
    }), mailboxes)).toBeNull();
  });

  it('gives no preview for a regular expression on the body', () => {
    expect(previewPlan(rule({ conditions: [{ field: 'body', comparator: 'regex', value: 'a+' }] }), mailboxes)).toBeNull();
  });

  it('lists the newest match first with its sender, subject and date', async () => {
    const { target } = server(() => [
      message('m2', 'old@x.example', 'older', { receivedAt: '2026-10-01T00:00:00Z' }),
      message('m1', 'new@x.example', 'newer', { receivedAt: '2026-11-01T00:00:00Z' }),
    ]);
    const preview = await previewRule(target, rule({ conditions: [{ field: 'from', comparator: 'contains', value: 'x.example' }] }));
    expect(preview!.items).toEqual([
      { id: 'm1', from: 'new', subject: 'newer', receivedAt: '2026-11-01T00:00:00Z' },
      { id: 'm2', from: 'old', subject: 'older', receivedAt: '2026-10-01T00:00:00Z' },
    ]);
  });
});
