import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { mockSieveAccount } from '@/lib/filters/__tests__/sieve-mock';
import { FolderRulesSubMenu } from '../rules-menu';
import { ContextMenu } from '@/components/ui/context-menu';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useToastStore } from '@/stores/toast-store';
import { useQuickRuleStore } from '@/stores/quick-rule-store';
import { APPLY_LIMIT } from '@/lib/filters/rule-scope';

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'archive', name: 'Old stuff', role: null, parentId: null, myRights: { mayAddItems: true } },
  { id: 'news', name: 'News', role: null, parentId: null, myRights: { mayAddItems: true } },
  { id: 'trash', name: 'Trash', role: 'trash', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];
/** Mail in Trash is never sorted again, also when it is in the folder too. */
const NOT_TRASH = { operator: 'NOT', conditions: [{ inMailbox: 'trash' }] };

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

function setup(rules: FilterRule[], supportsSieve = true) {
  const account = mockSieveAccount('a', [{ name: 'filters', content: generateScript(rules), isActive: true }]);
  Object.assign(account.client, { supportsSieve: () => supportsSieve });
  useAuthStore.setState({ client: account.client, activeAccountId: 'login-a' } as never);
  return account;
}

function renderMenu(mailbox: Mailbox) {
  return render(
    <ContextMenu isOpen position={{ x: 0, y: 0 }} onClose={() => {}}>
      <FolderRulesSubMenu mailbox={mailbox} onClose={() => {}} />
    </ContextMenu>,
  );
}

function openRules() {
  fireEvent.mouseEnter(screen.getByTestId('mailbox-rules').parentElement!);
}

describe('Rules entry of the folder menu', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts();
    useEmailStore.setState({ mailboxes, viewingAccountId: null, accountMailboxes: {}, error: null });
  });

  it('runs a saved rule on the mail already in the folder', async () => {
    const account = setup([rule('r1')]);
    account.client.queryEmailFields.mockResolvedValue([
      { id: 'e1', mailboxIds: { archive: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
      { id: 'e2', mailboxIds: { archive: true }, keywords: {}, from: [{ email: 'bob@acme.com' }] },
    ]);
    const batchMoveToMailbox = vi.fn(async () => true);
    useEmailStore.setState({ batchMoveToMailbox });

    renderMenu(mailboxes[1]);
    openRules();
    fireEvent.click(await screen.findByTestId('folder-rules:run:r1'));

    // The progress toast names the rule and the folder while it runs.
    expect(useToastStore.getState().toasts[0]).toMatchObject({ title: 'rules.running', progress: null });
    await vi.waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('rule_applied'));
    expect(useToastStore.getState().toasts.some((t) => t.title === 'rules.running')).toBe(false);
    expect(account.client.queryEmailFields).toHaveBeenCalledWith(
      { operator: 'AND', conditions: [{ inMailbox: 'archive' }, NOT_TRASH, { from: 'anna@acme.com' }] },
      expect.arrayContaining(['mailboxIds', 'keywords', 'from']),
      'a',
      APPLY_LIMIT,
    );
    expect(batchMoveToMailbox).toHaveBeenCalledWith(account.client, 'news', { emailIds: ['e1'], client: account.client, accountId: 'a' });
  });

  it('disables a rule that cannot run on existing mail, as Apply to in the rule dialog does', async () => {
    const account = setup([
      rule('body', { conditions: [{ field: 'body', comparator: 'contains', value: 'invoice' }] }),
      rule('forward', { actions: [{ type: 'forward', value: 'me@elsewhere.example' }] }),
      rule('delivered', { conditions: [{ field: 'delivered_to', comparator: 'address_is', value: 'shop@acme.com' }] }),
      rule('ok'),
    ]);
    renderMenu(mailboxes[1]);
    openRules();
    for (const id of ['body', 'forward', 'delivered']) {
      const item = await screen.findByTestId(`folder-rules:run:${id}`);
      expect(item).toHaveProperty('disabled', true);
      expect(item.textContent).toContain('rules.new_mail_only');
      expect(item.getAttribute('title')).toBe('rules.cannot_run');
      fireEvent.click(item);
    }
    expect(account.client.queryEmailFields).not.toHaveBeenCalled();
    expect(screen.getByTestId('folder-rules:run:ok')).toHaveProperty('disabled', false);
  });

  it('runs a rule with a period on the mail that arrived within it', async () => {
    const account = setup([rule('dated', { activeFrom: '2026-01-01T00:00:00Z', activeUntil: '2026-02-01T00:00:00Z' })]);
    account.client.queryEmailFields.mockResolvedValue([]);
    renderMenu(mailboxes[1]);
    openRules();
    const dated = await screen.findByTestId('folder-rules:run:dated');
    expect(dated).toHaveProperty('disabled', false);
    fireEvent.click(dated);
    await vi.waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('rule_applied'));
    expect((account.client.queryEmailFields.mock.calls[0] as unknown[])[0]).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'archive' }, NOT_TRASH, { after: '2026-01-01T00:00:00Z' }, { before: '2026-02-01T00:00:01Z' }, { from: 'anna@acme.com' }],
    });
  });

  describe('a rule that discards', () => {
    const discarding = () => rule('bin', { actions: [{ type: 'discard' }], stopProcessing: false });
    const found = [
      { id: 'e1', mailboxIds: { archive: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
      { id: 'e2', mailboxIds: { archive: true }, keywords: {}, from: [{ email: 'anna@acme.com' }] },
    ];

    it('asks how many messages go to Trash, and moves them there once confirmed', async () => {
      const account = setup([discarding()]);
      account.client.queryEmailFields.mockResolvedValue(found);
      const batchMoveToMailbox = vi.fn(async () => true);
      useEmailStore.setState({ batchMoveToMailbox });

      renderMenu(mailboxes[1]);
      openRules();
      fireEvent.click(await screen.findByTestId('folder-rules:run:bin'));

      await vi.waitFor(() => expect(useQuickRuleStore.getState().trashQuestion?.count).toBe(2));
      expect(batchMoveToMailbox).not.toHaveBeenCalled();
      useQuickRuleStore.getState().answerTrash(true);
      await vi.waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('rule_applied'));
      expect(batchMoveToMailbox).toHaveBeenCalledWith(account.client, 'trash', { emailIds: ['e1', 'e2'], client: account.client, accountId: 'a' });
    });

    it('moves nothing when the question is cancelled', async () => {
      const account = setup([discarding()]);
      account.client.queryEmailFields.mockResolvedValue(found);
      const batchMoveToMailbox = vi.fn(async () => true);
      useEmailStore.setState({ batchMoveToMailbox });

      renderMenu(mailboxes[1]);
      openRules();
      fireEvent.click(await screen.findByTestId('folder-rules:run:bin'));

      await vi.waitFor(() => expect(useQuickRuleStore.getState().trashQuestion).not.toBeNull());
      useQuickRuleStore.getState().answerTrash(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(batchMoveToMailbox).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts.some((t) => t.title === 'rule_applied' || t.title === 'rules.running')).toBe(false);
    });
  });

  it('says so when the account has no rules', async () => {
    setup([]);
    renderMenu(mailboxes[1]);
    openRules();
    expect(await screen.findByTestId('folder-rules:empty')).toBeTruthy();
  });

  it('is hidden for an account without Sieve and for a shared folder', () => {
    setup([rule('r1')], false);
    const { unmount } = renderMenu(mailboxes[1]);
    expect(screen.queryByTestId('mailbox-rules')).toBeNull();
    unmount();

    setup([rule('r1')]);
    renderMenu({ ...mailboxes[1], id: 'owner:archive', isShared: true } as Mailbox);
    expect(screen.queryByTestId('mailbox-rules')).toBeNull();
  });
});
