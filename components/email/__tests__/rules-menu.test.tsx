import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { QuickRuleTarget } from '@/lib/filters/quick-rule-target';

const targets = new Map<string, QuickRuleTarget | null>();

vi.mock('@/lib/filters/quick-rule-target', () => ({
  resolveQuickRuleTarget: (email: Email) => targets.get(email.id) ?? null,
  getOwnAddresses: () => new Set(['me@example.org']),
  knownListId: () => null,
  loadListIds: async () => {},
  sourceMailboxOf: () => ({ id: 'inbox' }),
}));

const runPresetRule = vi.fn(async () => {});
vi.mock('@/lib/filters/quick-rule-flow', () => ({
  runPresetRule: (...args: unknown[]) => runPresetRule(...(args as [])),
  ensureFiltersStatus: () => {},
  openFilterSettings: async () => {},
}));

const { RulesContextSubMenu } = await import('../rules-menu');
const { ContextMenu } = await import('@/components/ui/context-menu');
const { useAuthStore } = await import('@/stores/auth-store');
const { useFilterStore } = await import('@/stores/filter-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const client = { name: 'client-a' };
const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'news', name: 'News', role: null, parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function target(overrides: Partial<QuickRuleTarget> = {}): QuickRuleTarget {
  return {
    client: client as never,
    clientAccountId: 'login-a',
    key: 'a',
    accountId: 'a',
    sieveAccountId: 'a',
    shared: false,
    supportsSieve: true,
    mailboxes,
    ...overrides,
  };
}

function email(id: string, from = 'anna@acme.com'): Email {
  return { id, from: [{ name: 'Anna Schmidt', email: from }], to: [], subject: 'Hi', mailboxIds: { inbox: true }, keywords: {} } as unknown as Email;
}

function renderMenu(anchor: Email, senderEmails: Email[] = [anchor]) {
  return render(
    <ContextMenu isOpen position={{ x: 0, y: 0 }} onClose={() => {}}>
      <RulesContextSubMenu anchor={anchor} senderEmails={senderEmails} onClose={() => {}} />
    </ContextMenu>,
  );
}

function openRules() {
  fireEvent.mouseEnter(screen.getByTestId('ctx-rules').parentElement!);
}

describe('Rules entry of the message menu', () => {
  beforeEach(() => {
    targets.clear();
    runPresetRule.mockClear();
    useAuthStore.setState({ client } as never);
    useFilterStore.setState({ selectedAccountId: 'a', isSupported: true, isLoading: false, error: null, isOpaque: false });
    useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
  });

  it('is hidden for an account without Sieve', () => {
    targets.set('e1', target({ supportsSieve: false }));
    renderMenu(email('e1'));
    expect(screen.queryByTestId('ctx-rules')).toBeNull();
  });

  it('is hidden for a message in a shared account', () => {
    targets.set('e1', target({ shared: true, key: 'shared' }));
    renderMenu(email('e1'));
    expect(screen.queryByTestId('ctx-rules')).toBeNull();
  });

  it('is disabled, with the reason, for a selection that spans accounts', () => {
    targets.set('e1', target());
    targets.set('e2', target({ key: 'b', accountId: 'b', sieveAccountId: 'b' }));
    const anchor = email('e1');
    renderMenu(anchor, [anchor, email('e2', 'bob@b.org')]);
    const entry = screen.getByTestId('ctx-rules');
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    expect(entry).toHaveTextContent('rules.cross_account');
    openRules();
    expect(screen.queryByTestId('rules:mark_read')).toBeNull();
  });

  it('locks every item but Manage rules when the script was edited by hand', () => {
    useFilterStore.setState({ isOpaque: true });
    targets.set('e1', target());
    renderMenu(email('e1'));
    openRules();
    expect(screen.getByTestId('rules:opaque-hint')).toHaveTextContent('rules.opaque_hint');
    expect(screen.getByTestId('rules:mark_read')).toBeDisabled();
    expect(screen.getByTestId('rules:block')).toBeDisabled();
    expect(screen.getByTestId('rules:create')).toBeDisabled();
    expect(screen.getByTestId('rules:move_sender')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('rules:tag')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('rules:manage')).not.toBeDisabled();
  });

  it('saves a preset for the message account and its sender', () => {
    const t = target();
    targets.set('e1', t);
    renderMenu(email('e1'));
    openRules();
    fireEvent.click(screen.getByTestId('rules:mark_read'));
    expect(runPresetRule).toHaveBeenCalledTimes(1);
    expect(runPresetRule.mock.calls[0]).toMatchObject([{
      target: t,
      preset: { kind: 'mark_read' },
      subject: { senders: [{ email: 'anna@acme.com', name: 'Anna Schmidt' }], domain: 'acme.com', listId: null },
      sourceMailboxId: 'inbox',
    }]);
  });

  it('disables Block sender with a hint when the account has no Junk folder', () => {
    targets.set('e1', target());
    renderMenu(email('e1'));
    openRules();
    expect(screen.getByTestId('rules:block')).toBeDisabled();
    expect(screen.getByTestId('rules:block')).toHaveTextContent('rules.no_junk');
  });

  it('offers no sender presets for the user\'s own message, but still Create rule and Manage rules', () => {
    targets.set('e1', target());
    renderMenu(email('e1', 'me@example.org'));
    openRules();
    expect(screen.queryByTestId('rules:move_sender')).toBeNull();
    expect(screen.queryByTestId('rules:mark_read')).toBeNull();
    expect(screen.queryByTestId('rules:block')).toBeNull();
    expect(screen.getByTestId('rules:create')).not.toBeDisabled();
    expect(screen.getByTestId('rules:manage')).toBeInTheDocument();
  });
});
