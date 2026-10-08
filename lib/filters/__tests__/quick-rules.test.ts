import { describe, it, expect } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import {
  applyQuickRule,
  buildPrefillRule,
  buildPresetRule,
  buildSuggestions,
  collectSenders,
  extractListId,
  findJunkMailbox,
  insertRuleAtTop,
  mailboxSievePath,
  replaceOrInsertRule,
  ruleTargetMailboxIds,
  rulesMenuAvailability,
  sharedDomain,
  sharedListId,
  stripSubjectPrefixes,
  type QuickRuleSubject,
  type Translate,
} from '../quick-rules';

/** Renders "key {a=1,b=2}" so assertions can see what was asked for. */
const t: Translate = (key, values) =>
  values ? `${key} ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')}` : key;

const from = (email: string, name?: string) => ({ from: [{ email, name: name ?? '' }] }) as Pick<Email, 'from'>;

const own = new Set(['me@acme.com', 'alias@me.org']);

const news = { id: 'mb-news', path: 'News', name: 'News' };
const junk = { id: 'mb-junk', path: 'Junk', name: 'Junk' };

function subjectFor(emails: Array<Pick<Email, 'from'>>, listId: string | null = null): QuickRuleSubject {
  const senders = collectSenders(emails, own);
  return { senders, domain: sharedDomain(senders), listId };
}

function rule(overrides: Partial<FilterRule>): FilterRule {
  return {
    id: 'r',
    name: 'R',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
    actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }],
    stopProcessing: true,
    ...overrides,
  };
}

describe('collectSenders', () => {
  it('keeps the display name and lower-cases the address', () => {
    expect(collectSenders([from('Anna@Acme.com', 'Anna Schmidt')], own)).toEqual([
      { email: 'anna@acme.com', name: 'Anna Schmidt' },
    ]);
  });

  it('leaves the name out when the message has none', () => {
    expect(collectSenders([from('anna@acme.com')], own)).toEqual([{ email: 'anna@acme.com' }]);
  });

  it('dedupes case-insensitively and keeps the first name seen', () => {
    const senders = collectSenders(
      [from('anna@acme.com'), from('ANNA@acme.com', 'Anna'), from('bob@acme.com', 'Bob'), from('anna@ACME.COM', 'Other')],
      own,
    );
    expect(senders).toEqual([
      { email: 'anna@acme.com', name: 'Anna' },
      { email: 'bob@acme.com', name: 'Bob' },
    ]);
  });

  it("drops the user's own identities", () => {
    expect(collectSenders([from('Me@Acme.com', 'Me'), from('alias@me.org'), from('bob@x.org')], own)).toEqual([
      { email: 'bob@x.org' },
    ]);
  });
});

describe('sharedDomain', () => {
  it('finds the one domain all senders share', () => {
    expect(sharedDomain(collectSenders([from('anna@acme.com'), from('Bob@ACME.com')], own))).toBe('acme.com');
  });

  it('is null when the domains differ or there are no senders', () => {
    expect(sharedDomain(collectSenders([from('anna@acme.com'), from('bob@sub.acme.com')], own))).toBeNull();
    expect(sharedDomain([])).toBeNull();
  });
});

describe('List-Id', () => {
  it('takes the id inside the angle brackets', () => {
    expect(extractListId('Weekly news <news.acme.com>')).toBe('news.acme.com');
    expect(extractListId(['<list.example.org>'])).toBe('list.example.org');
    expect(extractListId(' bare.example.org ')).toBe('bare.example.org');
  });

  it('rejects what is not an id', () => {
    expect(extractListId(undefined)).toBeNull();
    expect(extractListId('two words')).toBeNull();
    expect(extractListId('')).toBeNull();
  });

  it('is shared only when every message has the same one', () => {
    expect(sharedListId(['news.acme.com', 'NEWS.acme.com'])).toBe('news.acme.com');
    expect(sharedListId(['news.acme.com', 'other.acme.com'])).toBeNull();
    expect(sharedListId(['news.acme.com', null])).toBeNull();
    expect(sharedListId(['news.acme.com', undefined])).toBeNull();
  });
});

describe('stripSubjectPrefixes', () => {
  it('removes reply and forward prefixes, repeatedly', () => {
    expect(stripSubjectPrefixes('Re: AW: Fwd: WG: Weekly report')).toBe('Weekly report');
    expect(stripSubjectPrefixes('RE[2]: Fw: Invoice')).toBe('Invoice');
    expect(stripSubjectPrefixes('Report: Re: numbers')).toBe('Report: Re: numbers');
  });
});

describe('preset rules', () => {
  const one = subjectFor([from('anna@acme.com', 'Anna Schmidt')], 'news.acme.com');
  const several = subjectFor([from('anna@acme.com'), from('bob@acme.com')]);

  it('moves one sender by exact address, at the top, stopping', () => {
    const r = buildPresetRule({ kind: 'move_sender', mailbox: news }, one, t, 'id-1');
    expect(r).toEqual({
      id: 'id-1',
      name: 'quick_rule_names.move_sender sender=anna@acme.com,folder=News',
      enabled: true,
      matchType: 'all',
      conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
      actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }],
      stopProcessing: true,
    });
  });

  it('uses every sender as an OR list and names them by count', () => {
    const r = buildPresetRule({ kind: 'move_sender', mailbox: news }, several, t, 'id');
    expect(r.conditions).toEqual([{ field: 'from', comparator: 'address_is', value: ['anna@acme.com', 'bob@acme.com'] }]);
    expect(r.name).toBe('quick_rule_names.move_sender sender=quick_rule_names.senders count=2,folder=News');
  });

  it('matches a domain on the address domain', () => {
    const r = buildPresetRule({ kind: 'move_domain', mailbox: news }, several, t, 'id');
    expect(r.conditions).toEqual([{ field: 'from', comparator: 'domain_is', value: 'acme.com' }]);
  });

  it('matches a list on its List-Id header', () => {
    const r = buildPresetRule({ kind: 'move_list', mailbox: news }, one, t, 'id');
    expect(r.conditions).toEqual([{ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news.acme.com' }]);
  });

  it('marks read and tags', () => {
    expect(buildPresetRule({ kind: 'mark_read' }, one, t, 'id').actions).toEqual([{ type: 'mark_read' }]);
    const tagged = buildPresetRule({ kind: 'tag', tagId: 'work', tagName: 'Work' }, one, t, 'id');
    expect(tagged.actions).toEqual([{ type: 'add_label', value: 'work' }]);
  });

  it('blocks into the Junk folder by id, past the spam guard', () => {
    const r = buildPresetRule({ kind: 'block', junk }, one, t, 'id');
    expect(r.actions).toEqual([{ type: 'move', value: 'Junk', mailboxId: 'mb-junk' }]);
    expect(r.includeSpam).toBe(true);
    expect(r.stopProcessing).toBe(true);
    expect(r.name).toBe('quick_rule_names.block sender=anna@acme.com');
  });

  it('prefills the editor with the senders and a Move without a folder', () => {
    const r = buildPrefillRule(several, t, 'id');
    expect(r.conditions).toEqual([{ field: 'from', comparator: 'address_is', value: ['anna@acme.com', 'bob@acme.com'] }]);
    expect(r.actions).toEqual([{ type: 'move', value: '' }]);
    expect(r.stopProcessing).toBe(true);
    expect(r.matchType).toBe('all');
    expect(buildPrefillRule(subjectFor([]), t, 'id').conditions).toEqual([]);
  });
});

describe('applyQuickRule', () => {
  const candidate = (value: string | string[], mailboxId = 'mb-news') => rule({
    id: 'new',
    name: 'New',
    conditions: [{ field: 'from', comparator: 'address_is', value }],
    actions: [{ type: 'move', value: 'X', mailboxId }],
  });

  it('puts a new rule at the top of the Bulwark rules', () => {
    const existing = [rule({ id: 'a', conditions: [{ field: 'subject', comparator: 'contains', value: 'x' }] })];
    const outcome = applyQuickRule(existing, candidate('anna@acme.com'));
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.rules.map(r => r.id)).toEqual(['new', 'a']);
    expect(outcome.rules[0].stopProcessing).toBe(true);
    expect(outcome.added).toBe(outcome.rule);
  });

  it('adds a sender to a rule with the same action and target, keeping its name, place and state', () => {
    const existing = [
      rule({ id: 'first', conditions: [{ field: 'subject', comparator: 'contains', value: 'x' }] }),
      rule({ id: 'target', name: 'Newsletters', conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }] }),
    ];
    const outcome = applyQuickRule(existing, candidate(['BOB@acme.com', 'anna@ACME.com']));
    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;
    expect(outcome.rules.map(r => r.id)).toEqual(['first', 'target']);
    expect(outcome.rule.name).toBe('Newsletters');
    expect(outcome.rule.enabled).toBe(true);
    expect(outcome.rule.conditions[0].value).toEqual(['anna@acme.com', 'BOB@acme.com']);
    // The retroactive pass runs for the new sender only.
    expect(outcome.added.conditions[0].value).toBe('BOB@acme.com');
    expect(outcome.added.id).toBe('target');
  });

  it('writes nothing when every value is already covered', () => {
    const existing = [rule({ id: 'target', name: 'Newsletters', conditions: [{ field: 'from', comparator: 'address_is', value: ['anna@acme.com', 'bob@acme.com'] }] })];
    const outcome = applyQuickRule(existing, candidate('Anna@Acme.com'));
    expect(outcome).toEqual({ kind: 'covered', rule: existing[0] });
  });

  it('creates a new rule for a different folder', () => {
    const existing = [rule({ id: 'target' })];
    const outcome = applyQuickRule(existing, candidate('bob@acme.com', 'mb-other'));
    expect(outcome.kind).toBe('created');
  });

  it('does not merge across condition kinds, multi-condition rules, disabled or external rules', () => {
    const cases: FilterRule[] = [
      rule({ id: 'domain', conditions: [{ field: 'from', comparator: 'domain_is', value: 'acme.com' }] }),
      rule({ id: 'contains', conditions: [{ field: 'from', comparator: 'contains', value: 'anna@acme.com' }] }),
      rule({ id: 'two', conditions: [
        { field: 'from', comparator: 'address_is', value: 'anna@acme.com' },
        { field: 'subject', comparator: 'contains', value: 'x' },
      ] }),
      rule({ id: 'off', enabled: false }),
      rule({ id: 'ext', origin: 'external', rawBlock: 'if true { keep; }' }),
      rule({ id: 'more-actions', actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }, { type: 'mark_read' }] }),
    ];
    for (const existing of cases) {
      expect(applyQuickRule([existing], candidate('bob@acme.com')).kind).toBe('created');
    }
  });

  it('leaves a rule with a period alone, since the new values would only act within it', () => {
    for (const period of [{ activeFrom: '2026-10-05T06:00:00.000Z' }, { activeUntil: '2026-10-16T16:00:00.000Z' }]) {
      const existing = [rule({ id: 'target', ...period })];
      // Neither merged into it nor counted as covered by it.
      expect(applyQuickRule(existing, candidate('bob@acme.com')).kind).toBe('created');
      expect(applyQuickRule(existing, candidate('anna@acme.com')).kind).toBe('created');
    }
  });

  it('merges List-Id rules by header name, whatever its case', () => {
    const existing = [rule({ id: 'lists', conditions: [{ field: 'header', headerName: 'list-id', comparator: 'contains', value: 'a.example.org' }] })];
    const outcome = applyQuickRule(existing, rule({
      id: 'new',
      conditions: [{ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'b.example.org' }],
    }));
    expect(outcome.kind).toBe('merged');
  });

  it('merges a tag rule only for the same tag, a mark-read rule for any mark-read rule', () => {
    const tagged = rule({ id: 'tag', actions: [{ type: 'add_label', value: 'work' }] });
    const tagCandidate = (tag: string) => rule({
      id: 'new', conditions: [{ field: 'from', comparator: 'address_is', value: 'bob@acme.com' }], actions: [{ type: 'add_label', value: tag }],
    });
    expect(applyQuickRule([tagged], tagCandidate('work')).kind).toBe('merged');
    expect(applyQuickRule([tagged], tagCandidate('home')).kind).toBe('created');
    const read = rule({ id: 'read', actions: [{ type: 'mark_read' }] });
    expect(applyQuickRule([read], rule({ id: 'new', conditions: [{ field: 'from', comparator: 'address_is', value: 'bob@acme.com' }], actions: [{ type: 'mark_read' }] })).kind).toBe('merged');
  });
});

describe('placement helpers', () => {
  it('inserts at the top and replaces in place', () => {
    const a = rule({ id: 'a' });
    const b = rule({ id: 'b' });
    expect(insertRuleAtTop([a], b).map(r => r.id)).toEqual(['b', 'a']);
    expect(replaceOrInsertRule([a, b], { ...a, name: 'changed' }).map(r => [r.id, r.name])).toEqual([['a', 'changed'], ['b', 'R']]);
    expect(replaceOrInsertRule([a], b).map(r => r.id)).toEqual(['b', 'a']);
  });
});

describe('rulesMenuAvailability', () => {
  const account = (key: string, overrides: Partial<{ shared: boolean; supportsSieve: boolean }> = {}) =>
    ({ key, shared: false, supportsSieve: true, ...overrides });

  it('offers rules for one personal account with Sieve', () => {
    expect(rulesMenuAvailability([account('a'), account('a')])).toBe('available');
  });

  it('hides them without Sieve', () => {
    expect(rulesMenuAvailability([account('a', { supportsSieve: false })])).toBe('hidden');
  });

  it('hides them for a shared or group account', () => {
    expect(rulesMenuAvailability([account('a', { shared: true })])).toBe('hidden');
  });

  it('disables them for a selection that spans accounts', () => {
    expect(rulesMenuAvailability([account('a'), account('b')])).toBe('cross_account');
    expect(rulesMenuAvailability([account('a'), account('b', { shared: true })])).toBe('cross_account');
  });

  it('hides them when an account cannot be resolved', () => {
    expect(rulesMenuAvailability([])).toBe('hidden');
    expect(rulesMenuAvailability([account('a'), null])).toBe('hidden');
  });
});

describe('folders', () => {
  const mailboxes = [
    { id: 'inbox', name: 'Posteingang', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
    { id: 'drafts', name: 'Drafts', role: 'drafts', parentId: null, myRights: { mayAddItems: true } },
    { id: 'junk', name: 'Junk', role: 'junk', parentId: null, myRights: { mayAddItems: true } },
    { id: 'news', name: 'News', role: null, parentId: 'inbox', myRights: { mayAddItems: true } },
    { id: 'ro', name: 'Read only', role: null, parentId: null, myRights: { mayAddItems: false } },
    { id: 'o:shared', name: 'Shared', role: null, parentId: null, isShared: true, accountId: 'o', myRights: { mayAddItems: true } },
  ] as unknown as Mailbox[];

  it('offers own folders that take mail, with the Inbox and without Drafts', () => {
    expect([...ruleTargetMailboxIds(mailboxes)]).toEqual(['inbox', 'junk', 'news']);
  });

  it('writes the Sieve path with INBOX for the inbox', () => {
    expect(mailboxSievePath(mailboxes, 'news')).toBe('INBOX/News');
    expect(mailboxSievePath(mailboxes, 'junk')).toBe('Junk');
  });

  it('finds the Junk folder by role', () => {
    expect(findJunkMailbox(mailboxes)?.id).toBe('junk');
    expect(findJunkMailbox(mailboxes.filter(m => m.role !== 'junk'))).toBeUndefined();
  });
});

describe('buildSuggestions', () => {
  const anchor = {
    subject: 'Re: AW: Weekly report, March',
    to: [{ name: 'Me', email: 'ME@acme.com' }],
    cc: [],
  } as unknown as Email;

  it('offers subject, own address, List-Id and domain', () => {
    const suggestions = buildSuggestions(anchor, subjectFor([from('anna@acme.com')], 'news.acme.com'), own, t);
    expect(suggestions.map(s => s.id)).toEqual(['subject', 'to', 'list', 'domain']);
    // A comma would split a plain value into a list in the editor.
    expect(suggestions[0].condition).toEqual({ field: 'subject', comparator: 'contains', value: ['Weekly report, March'] });
    expect(suggestions[1].condition).toEqual({ field: 'to', comparator: 'address_is', value: 'me@acme.com' });
    expect(suggestions[2].condition).toEqual({ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news.acme.com' });
    const domain = suggestions[3];
    expect(domain.condition).toEqual({ field: 'from', comparator: 'domain_is', value: 'acme.com' });
    expect(domain.replaces?.({ field: 'from', comparator: 'address_is', value: 'x' })).toBe(true);
  });

  it('uses Cc when that is where the user was, and skips what is missing', () => {
    const cc = { subject: '', to: [{ email: 'x@y.org' }], cc: [{ email: 'alias@me.org' }] } as unknown as Email;
    const suggestions = buildSuggestions(cc, subjectFor([]), own, t);
    expect(suggestions.map(s => s.id)).toEqual(['to']);
    expect(suggestions[0].condition.field).toBe('cc');
  });
});
