import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { useToastStore } from '@/stores/toast-store';
import { useQuickRuleStore } from '@/stores/quick-rule-store';
import { runPresetRule, saveEditorRule, type QuickRuleText } from '../quick-rule-flow';
import type { QuickRuleTarget } from '../quick-rule-target';
import { collectSenders, sharedDomain, type QuickRuleSubject } from '../quick-rules';
import { mockSieveAccount } from './sieve-mock';

const translate = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join('|')})` : key;
const text: QuickRuleText = { notifications: translate, filters: translate, menu: translate };

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'news', name: 'News', role: null, parentId: null, myRights: { mayAddItems: true } },
  { id: 'junk', name: 'Junk', role: 'junk', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function targetFor(account: ReturnType<typeof mockSieveAccount>, id: string): QuickRuleTarget {
  return {
    client: account.client,
    clientAccountId: `login-${id}`,
    key: `k-${id}`,
    accountId: id,
    sieveAccountId: id,
    shared: false,
    supportsSieve: true,
    mailboxes,
  };
}

function subject(...addresses: string[]): QuickRuleSubject {
  const senders = collectSenders(addresses.map((email) => ({ from: [{ email, name: '' }] })), new Set());
  return { senders, domain: sharedDomain(senders), listId: null };
}

function rule(id: string, overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id,
    name: `Rule ${id}`,
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
    actions: [{ type: 'move', value: 'News', mailboxId: 'news' }],
    stopProcessing: true,
    ...overrides,
  };
}

const news = { id: 'news', path: 'News', name: 'News' };
const lastToast = () => useToastStore.getState().toasts.at(-1)!;

describe('quick rules from a message', () => {
  let accountA: ReturnType<typeof mockSieveAccount>;
  let accountB: ReturnType<typeof mockSieveAccount>;
  let scriptA: string;

  beforeEach(() => {
    useToastStore.getState().clearToasts();
    useQuickRuleStore.setState({ editor: null, newFolder: null, statuses: {} });
    scriptA = generateScript([rule('a-only', { name: 'A rule' })]);
    accountA = mockSieveAccount('a', [{ name: 'filters', content: scriptA, isActive: true }]);
    accountB = mockSieveAccount('b', [{ name: 'filters', content: generateScript([]), isActive: true }]);
    // Settings holds account A, from the active login.
    useAuthStore.setState({ client: accountA.client } as never);
    useFilterStore.setState({
      selectedAccountId: 'a',
      activeScriptId: 'script-1',
      rules: parseScript(scriptA).rules,
      rawScript: scriptA,
      isOpaque: false,
      isSupported: true,
    });
  });

  it("writes a rule for account B into B's script and never touches account A", async () => {
    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com'), sourceMailboxId: 'inbox', text });

    expect(accountA.writes()).toBe(0);
    expect(accountA.content('filters')).toBe(scriptA);
    expect(useFilterStore.getState().rules.map((r) => r.id)).toEqual(['a-only']);
    const written = parseScript(accountB.content('filters'));
    expect(written.rules).toHaveLength(1);
    expect(written.rules[0]).toMatchObject({
      conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
      actions: [{ type: 'move', value: 'News', mailboxId: 'news' }],
      stopProcessing: true,
    });
    expect(accountB.content('filters')).toContain('address :is "From" "anna@acme.com"');
    expect(lastToast().title).toBe('rule_created');
  });

  it('refreshes the filter store when it holds the account the rule went to', async () => {
    const original = useFilterStore.getState().fetchFilters;
    const fetchFilters = vi.fn(async () => {});
    useFilterStore.setState({ fetchFilters });
    try {
      await runPresetRule({ target: targetFor(accountA, 'a'), preset: { kind: 'mark_read' }, subject: subject('bob@acme.com'), sourceMailboxId: null, text });
      expect(fetchFilters).toHaveBeenCalledWith(accountA.client, 'a');
      expect(parseScript(accountA.content('filters')).rules.map((r) => r.id)).toHaveLength(2);
    } finally {
      useFilterStore.setState({ fetchFilters: original });
    }
  });

  it('adds a second sender to the same rule, and Undo restores the script exactly', async () => {
    const before = generateScript([rule('first', { name: 'Newsletters' })]);
    accountB = mockSieveAccount('b', [{ name: 'filters', content: before, isActive: true }]);

    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('bob@acme.com'), sourceMailboxId: null, text });

    const merged = parseScript(accountB.content('filters')).rules;
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Newsletters');
    expect(merged[0].conditions[0].value).toEqual(['anna@acme.com', 'bob@acme.com']);
    const toast = lastToast();
    expect(toast.title).toBe('rule_merged(Newsletters)');
    expect(toast.action?.label).toBe('rule_undo');
    expect(toast.secondaryAction?.label).toBe('rule_edit');

    toast.action!.onClick();
    await vi.waitFor(() => expect(lastToast().title).toBe('rule_undone'));
    expect(accountB.content('filters')).toBe(before);
  });

  it('writes nothing when the sender is already covered', async () => {
    accountB = mockSieveAccount('b', [{ name: 'filters', content: generateScript([rule('first', { name: 'Newsletters' })]), isActive: true }]);
    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('Anna@acme.com'), sourceMailboxId: null, text });
    expect(accountB.writes()).toBe(0);
    expect(lastToast()).toMatchObject({ type: 'info', title: 'rule_already_covered(Newsletters)' });
    expect(lastToast().action?.label).toBe('rule_edit');
  });

  it('creates a new rule on top for a different folder', async () => {
    accountB = mockSieveAccount('b', [{ name: 'filters', content: generateScript([rule('first')]), isActive: true }]);
    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'move_sender', mailbox: { id: 'junk', path: 'Junk', name: 'Junk' } }, subject: subject('anna@acme.com'), sourceMailboxId: null, text });
    const rules = parseScript(accountB.content('filters')).rules;
    expect(rules).toHaveLength(2);
    expect(rules[1].id).toBe('first');
    expect(rules[0].actions[0].mailboxId).toBe('junk');
  });

  it('blocks into Junk with the spam guard off', async () => {
    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'block', junk: { id: 'junk', path: 'Junk', name: 'Junk' } }, subject: subject('spam@acme.com'), sourceMailboxId: null, text });
    const script = accountB.content('filters');
    expect(parseScript(script).rules[0].includeSpam).toBe(true);
    expect(script).toContain('if address :is "From" "spam@acme.com" {\n    fileinto :mailboxid "junk" "Junk";\n    stop;\n}');
  });

  it('refuses a hand-edited script and says why', async () => {
    accountB = mockSieveAccount('b', [{ name: 'filters', content: 'require "fileinto";', isActive: true }]);
    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'mark_read' }, subject: subject('anna@acme.com'), sourceMailboxId: null, text });
    expect(accountB.writes()).toBe(0);
    expect(lastToast()).toMatchObject({ type: 'error', title: 'rules.opaque_hint' });
    expect(useQuickRuleStore.getState().statuses['k-b']?.status).toBe('opaque');
  });

  it('offers to apply the rule to matching mail in the folder, through the store batch move', async () => {
    accountB.client.queryEmailFields.mockResolvedValue([
      { id: 'e1', mailboxIds: { inbox: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
      { id: 'e2', mailboxIds: { inbox: true }, keywords: {}, from: [{ email: 'joanna@acme.com' }] },
      { id: 'e3', mailboxIds: { inbox: true }, keywords: { $seen: true }, from: [{ email: 'ANNA@acme.com' }] },
    ]);
    const batchMoveToMailbox = vi.fn(async () => {});
    useEmailStore.setState({ batchMoveToMailbox, error: null });

    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com'), sourceMailboxId: 'inbox', text });

    expect(accountB.client.queryEmailFields).toHaveBeenCalledWith(
      { operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { from: 'anna@acme.com' }] },
      ['mailboxIds', 'keywords', 'from'],
      'b',
    );
    const toast = lastToast();
    expect(toast.tertiaryAction?.label).toBe('rule_apply_existing(2)');

    toast.tertiaryAction!.onClick();
    await vi.waitFor(() => expect(lastToast().title).toBe('rule_applied(2)'));
    expect(batchMoveToMailbox).toHaveBeenCalledWith(accountA.client, 'news', { emailIds: ['e1', 'e3'], client: accountB.client, accountId: 'b' });
  });

  it('offers no apply action when nothing in the folder matches', async () => {
    await runPresetRule({ target: targetFor(accountB, 'b'), preset: { kind: 'move_sender', mailbox: news }, subject: subject('anna@acme.com'), sourceMailboxId: 'inbox', text });
    expect(lastToast().tertiaryAction).toBeUndefined();
  });

  it('saves "Create rule…" as built, at the top, without merging', async () => {
    accountB = mockSieveAccount('b', [{ name: 'filters', content: generateScript([rule('first')]), isActive: true }]);
    const target = targetFor(accountB, 'b');
    await saveEditorRule({ mode: 'prefill', target, rule: rule('built'), suggestions: [], sourceMailboxId: 'inbox' }, rule('built'), false, text);
    expect(parseScript(accountB.content('filters')).rules.map((r) => r.id)).toEqual(['built', 'first']);
    expect(lastToast().title).toBe('rule_created');
  });

  it('saves an edit in place', async () => {
    accountB = mockSieveAccount('b', [{ name: 'filters', content: generateScript([rule('x'), rule('first')]), isActive: true }]);
    const target = targetFor(accountB, 'b');
    await saveEditorRule({ mode: 'edit', target, rule: rule('first'), suggestions: [], sourceMailboxId: null }, rule('first', { name: 'Renamed' }), false, text);
    expect(parseScript(accountB.content('filters')).rules.map((r) => [r.id, r.name])).toEqual([['x', 'Rule x'], ['first', 'Renamed']]);
  });
});
