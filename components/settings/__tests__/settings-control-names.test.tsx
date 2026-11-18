import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { RuleEditor } from '@/components/filters/rule-editor';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { FilterSettings } from '../filter-settings';

// SET-11: icon buttons and switches in Settings have a name that says what
// they do. The rule dialog's remove buttons were both named "Delete Rule";
// the rule switches on the Filters page had none.

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const rule: FilterRule = {
  id: 'r1', name: 'Newsletters', enabled: true, matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'a' }, { field: 'subject', comparator: 'contains', value: 'b' }],
  actions: [{ type: 'star' }, { type: 'mark_read' }], stopProcessing: false,
};

const initial = { auth: useAuthStore.getState(), email: useEmailStore.getState(), filter: useFilterStore.getState() };
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useEmailStore.setState(initial.email, true);
  useFilterStore.setState(initial.filter, true);
});

function unnamedButtons(root: HTMLElement) {
  return Array.from(root.querySelectorAll('button, [role="switch"]')).filter((b) => {
    const name = b.getAttribute('aria-label') || b.getAttribute('aria-labelledby') || b.textContent?.trim() || b.getAttribute('title');
    return !name;
  });
}

describe('names of settings controls', () => {
  it('names the remove buttons of a rule for what they remove', () => {
    render(<RuleEditor rule={rule} mailboxes={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: 'remove_condition' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'delete_rule' })).toBeNull();
    expect(unnamedButtons(screen.getByRole('dialog'))).toEqual([]);
  });

  it('names each rule switch on the Filters page after its rule', () => {
    useAuthStore.setState({ client: { updateSieveScript: vi.fn(), getSieveAccountId: () => 'primary' } as never });
    useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}) as never });
    useFilterStore.setState({
      rules: [rule], isSupported: true, isLoading: false, isOpaque: false, activeScriptId: 's',
      selectedAccountId: 'primary', sieveCapabilities: null, selectAccount: vi.fn(async () => {}),
    });
    const { container } = render(<FilterSettings />);
    expect(screen.getByRole('switch', { name: 'Newsletters' })).toBeTruthy();
    expect(unnamedButtons(container)).toEqual([]);
  });
});
