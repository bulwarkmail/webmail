import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import en from '@/locales/en/common.json';
import { RuleEditor } from '../rule-editor';

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl/core');
  const messages = (await import('@/locales/en/common.json')).default;
  return {
    useTranslations: (namespace?: string) => createTranslator({ locale: 'en', messages, namespace: namespace as never }),
    useLocale: () => 'en',
    useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
  };
});

const filters = en.settings.filters;

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function existing(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Statements',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'revolut.com' }],
    actions: [{ type: 'mark_read' }],
    stopProcessing: false,
    ...overrides,
  };
}

describe('RuleEditor', () => {
  it('makes a rule from ticked actions and names it after what it does when the name is left empty', () => {
    const onSave = vi.fn();
    render(<RuleEditor mailboxes={[]} onSave={onSave} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Condition value'), { target: { value: 'news@acme.com' } });
    fireEvent.click(screen.getByLabelText('Mark as read'));
    fireEvent.click(screen.getByLabelText('Star message'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved: FilterRule = onSave.mock.calls[0][0];
    expect(saved.actions).toEqual([{ type: 'mark_read' }, { type: 'star' }]);
    expect(saved.conditions).toEqual([{ field: 'from', comparator: 'contains', value: 'news@acme.com' }]);
    expect(saved.name).toBe('From news@acme.com → Mark as read, Star message');
  });

  it('opens a rule with its actions ticked', () => {
    render(<RuleEditor rule={existing({ actions: [{ type: 'star' }] })} mailboxes={[]} onSave={() => {}} onClose={() => {}} />);
    expect((screen.getByLabelText('Star message') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Mark as read') as HTMLInputElement).checked).toBe(false);
  });

  it('does not let a deleting rule also move the message', () => {
    render(<RuleEditor rule={existing({ actions: [{ type: 'discard' }] })} mailboxes={[]} onSave={() => {}} onClose={() => {}} />);
    expect((screen.getByLabelText('Move to folder') as HTMLInputElement).disabled).toBe(true);
  });

  it('stops later rules when "Continue to apply other rules" is unticked, and can skip the rule', () => {
    const onSave = vi.fn();
    render(<RuleEditor rule={existing()} mailboxes={[]} onSave={onSave} onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText('Continue to apply other rules'));
    fireEvent.click(screen.getByLabelText('Skip this rule'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0][0]).toMatchObject({ stopProcessing: true, enabled: false, name: 'Statements' });
  });

  it('offers "Has an attachment" as a condition of its own, without a comparison', () => {
    const onSave = vi.fn();
    render(<RuleEditor rule={existing()} mailboxes={[]} onSave={onSave} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Condition 1'), { target: { value: 'attachment_any' } });
    expect(screen.queryByLabelText('Condition value')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0][0].conditions).toEqual([{ field: 'attachment', comparator: 'has_any', value: '' }]);
  });

  it('shows the mail the rule would catch while the conditions are typed', async () => {
    const previewMatches = vi.fn().mockResolvedValue({
      items: [{ id: 'm1', from: 'Revolut', subject: 'Your account statement is available', receivedAt: '2026-11-03T00:00:00Z' }],
      total: 1,
      complete: true,
    });
    render(<RuleEditor rule={existing()} mailboxes={[]} previewMatches={previewMatches} onSave={() => {}} onClose={() => {}} />);

    const summary = await screen.findByText('1 message matches', {}, { timeout: 3000 });
    expect(previewMatches.mock.calls[0][0].conditions).toEqual([{ field: 'from', comparator: 'contains', value: 'revolut.com' }]);
    fireEvent.click(summary);
    await waitFor(() => expect(screen.getByText('Your account statement is available')).toBeTruthy());
  });

  it('announces the count in the live region that announced the search, so a screen reader hears it', async () => {
    const previewMatches = vi.fn().mockResolvedValue({ items: [], total: 4, complete: true });
    render(<RuleEditor rule={existing()} mailboxes={[]} previewMatches={previewMatches} onSave={() => {}} onClose={() => {}} />);
    const region = screen.getByText(en.settings.filters.editor.checking).closest('[aria-live]');
    expect(region).not.toBeNull();
    await screen.findByText('4 messages match', {}, { timeout: 3000 });
    expect(region!.isConnected).toBe(true);
    expect(region!.textContent).toBe('4 messages match');
  });

  it('offers to also apply the rule to the Inbox or to all mail, saying how many messages each covers', async () => {
    const onSave = vi.fn();
    const previewMatches = vi.fn().mockResolvedValue({ items: [], total: 7, complete: true, inFolder: 3 });
    render(
      <RuleEditor rule={existing()} mailboxes={[]} previewMatches={previewMatches} offerApplyToExisting applyExistingFolder="Inbox" onSave={onSave} onClose={() => {}} />,
    );

    const choice = (await screen.findByLabelText('Apply to', {}, { timeout: 3000 })) as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent)).toEqual(['New mail only', 'New mail and Inbox (3)', 'New mail and all mail (7)']);
    expect(choice.value).toBe('new');
    fireEvent.change(choice, { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0][1]).toEqual({ applyTo: 'all' });
  });

  it('marks a count as a lower bound when not all mail was looked at', async () => {
    const previewMatches = vi.fn().mockResolvedValue({ items: [], total: 1000, complete: false, inFolder: 40 });
    render(
      <RuleEditor rule={existing()} mailboxes={[]} previewMatches={previewMatches} offerApplyToExisting applyExistingFolder="Inbox" onSave={() => {}} onClose={() => {}} />,
    );
    const choice = (await screen.findByLabelText('Apply to', {}, { timeout: 3000 })) as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent)).toEqual(['New mail only', 'New mail and Inbox (40+)', 'New mail and all mail (1000+)']);
  });

  it('does not offer to apply a rule that only forwards, so old mail is never sent on', async () => {
    const previewMatches = vi.fn().mockResolvedValue({ items: [], total: 7, complete: true, inFolder: 3 });
    render(
      <RuleEditor
        rule={existing({ actions: [{ type: 'forward', value: 'me@elsewhere.example' }] })}
        mailboxes={[]}
        previewMatches={previewMatches}
        offerApplyToExisting
        applyExistingFolder="Inbox"
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findByText('7 messages match', {}, { timeout: 3000 });
    expect(screen.queryByLabelText('Apply to')).toBeNull();
  });

  it('treats a value of only commas as empty instead of saving a rule the server rejects', () => {
    const onSave = vi.fn();
    render(<RuleEditor mailboxes={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Condition value'), { target: { value: ' , ,' } });
    fireEvent.click(screen.getByLabelText('Star message'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(filters.validation_empty_conditions);
  });

  it('refuses an attachment type that names no extension, which the server would reject', () => {
    const onSave = vi.fn();
    render(<RuleEditor rule={existing()} mailboxes={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Condition 1'), { target: { value: 'attachment_type' } });
    fireEvent.change(screen.getByLabelText('Condition value'), { target: { value: '.*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Enter a file extension, such as pdf');
  });

  it('asks to untick one of two contradicting actions carried over from an older rule', () => {
    const onSave = vi.fn();
    render(
      <RuleEditor
        rule={existing({ actions: [{ type: 'move', value: 'News', mailboxId: 'news' }, { type: 'discard' }] })}
        mailboxes={[{ id: 'news', name: 'News', role: null } as never]}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(filters.editor.action_conflict);
    fireEvent.click(screen.getByLabelText('Discard (delete silently)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][0].actions).toEqual([{ type: 'move', value: 'News', mailboxId: 'news' }]);
  });

  it('says only recent mail was looked at, and still offers applying, when the scan stopped early', async () => {
    const previewMatches = vi.fn().mockResolvedValue({ items: [], total: 0, complete: false, inFolder: 0 });
    render(
      <RuleEditor rule={existing()} mailboxes={[]} previewMatches={previewMatches} offerApplyToExisting applyExistingFolder="Inbox" onSave={() => {}} onClose={() => {}} />,
    );
    await screen.findByText('No recent messages match', {}, { timeout: 3000 });
    const choice = screen.getByLabelText('Apply to') as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent)).toEqual(['New mail only', 'New mail and Inbox', 'New mail and all mail']);
  });

  it('offers "contains" and "does not contain" for the message text', () => {
    render(<RuleEditor rule={existing()} mailboxes={[]} onSave={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Condition 1'), { target: { value: 'body' } });
    const comparator = screen.getByLabelText('Comparison') as HTMLSelectElement;
    expect([...comparator.options].map((o) => o.value)).toEqual(['contains', 'not_contains']);
  });

  it('says what is missing instead of saving an empty rule', () => {
    const onSave = vi.fn();
    render(<RuleEditor mailboxes={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Condition value'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(filters.validation_empty_actions);
  });
});
