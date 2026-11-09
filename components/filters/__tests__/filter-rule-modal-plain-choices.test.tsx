import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { RuleSuggestion } from '@/lib/filters/quick-rules';
import type { Mailbox } from '@/lib/jmap/types';
import { FilterRuleModal } from '../filter-rule-modal';

// settings-13 and settings-9 (usability pass 2026-11-04): one way to stop
// later rules, and a folder picker that names folders as the sidebar does.

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

function mailbox(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: { mayAddItems: true } as Mailbox['myRights'], isSubscribed: true, isShared: false, ...extra,
  } as Mailbox;
}

const mailboxes = [
  mailbox('inbox', 'Inbox', { role: 'inbox' }),
  mailbox('drafts', 'Drafts', { role: 'drafts', sortOrder: 1 }),
  mailbox('sent', 'Sent Items', { role: 'sent', sortOrder: 2 }),
  mailbox('junk', 'Junk Mail', { role: 'junk', sortOrder: 3 }),
  mailbox('trash', 'Deleted Items', { role: 'trash', sortOrder: 4 }),
  mailbox('sched', 'Scheduled', { role: 'scheduled' as never, sortOrder: 5 }),
  mailbox('work', 'Work', { sortOrder: 6 }),
  mailbox('acme', 'Acme', { parentId: 'work' }),
];

function rule(actions: FilterRule['actions'], stopProcessing = false): FilterRule {
  return {
    id: 'r1', name: 'Old rule', enabled: true, matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'news@example.org' }],
    actions, stopProcessing,
  };
}

function openModal(props: Partial<React.ComponentProps<typeof FilterRuleModal>> = {}) {
  const onSave = vi.fn();
  render(<FilterRuleModal mailboxes={mailboxes} onSave={onSave} onClose={vi.fn()} {...props} />);
  return { onSave, saved: () => onSave.mock.calls[0][0] as FilterRule };
}

const actionTypeOptions = () =>
  [...(screen.getAllByLabelText('actions')[0] as HTMLSelectElement).options].map((o) => o.value);
const folderButton = () => screen.getByRole('button', { name: 'move_to_folder' });
/** Opens the folder field's Move list and reads its rows. */
const folderRows = () => {
  fireEvent.click(folderButton());
  return screen.getAllByTestId(/^rule-folder:/).map((el) => ({ value: el.getAttribute('data-testid')!.slice('rule-folder:'.length), text: el.textContent ?? '', el }));
};
const stopBox = () => screen.getByLabelText('stop_processing') as HTMLInputElement;

describe('stopping later rules', () => {
  it('is no longer offered as an action, only as the checkbox', () => {
    openModal();
    expect(actionTypeOptions()).not.toContain('stop');
    expect(stopBox()).toBeInTheDocument();
  });

  it('folds an old "stop" action into the checkbox and saves it that way', () => {
    const { saved } = openModal({ rule: rule([{ type: 'move', value: 'Work', mailboxId: 'work' }, { type: 'stop' }]) });
    expect(stopBox().checked).toBe(true);
    expect(actionTypeOptions()).not.toContain('stop');
    fireEvent.click(screen.getByText('save'));
    expect(saved().stopProcessing).toBe(true);
    expect(saved().actions.map((a) => a.type)).toEqual(['move']);
  });

  it('drops what came after the stop, which never ran', () => {
    const { saved } = openModal({ rule: rule([{ type: 'star' }, { type: 'stop' }, { type: 'mark_read' }]) });
    fireEvent.click(screen.getByText('save'));
    expect(saved().stopProcessing).toBe(true);
    expect(saved().actions.map((a) => a.type)).toEqual(['star']);
  });

  it('keeps the message in the inbox for a rule that only stopped', () => {
    const { saved } = openModal({ rule: rule([{ type: 'stop' }]) });
    expect(stopBox().checked).toBe(true);
    fireEvent.click(screen.getByText('save'));
    expect(saved().stopProcessing).toBe(true);
    expect(saved().actions).toEqual([{ type: 'keep' }]);
  });

  it('does not count the folded action as a change', async () => {
    const onClose = vi.fn();
    render(<FilterRuleModal mailboxes={mailboxes} rule={rule([{ type: 'stop' }])} onSave={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('cancel'));
    // No "discard changes?" question: the dialog closes at once.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

// mail-p3-9: the folder field is the Move list every other folder choice
// uses (Recent, nesting, the filter), not a native select with spaces.
describe('the folder picker of Move to folder', () => {
  it('names role folders as the sidebar does and leaves out Drafts, Sent and Scheduled', () => {
    openModal({ initialRule: rule([{ type: 'move', value: '' }]) });
    const rows = folderRows();
    const texts = rows.map((o) => o.text.trim());
    expect(texts).toContain('mailboxes.inbox');
    expect(texts).toContain('mailboxes.spam');
    expect(texts).toContain('mailboxes.trash');
    for (const hidden of ['Sent Items', 'Junk Mail', 'Deleted Items', 'mailboxes.sent', 'mailboxes.drafts', 'Drafts', 'Scheduled']) {
      expect(texts).not.toContain(hidden);
    }
    // Drawn over the dialog (z-[60]), not under it.
    expect(screen.getByRole('menu', { name: 'move_to_folder' }).className).toContain('z-[70]');
    // In the Move list's order: system folders first.
    expect(rows.map((o) => o.value)).toEqual(['inbox', 'junk', 'trash', 'work', 'acme']);
  });

  it('nests subfolders under their parent', () => {
    openModal({ initialRule: rule([{ type: 'move', value: '' }]) });
    const acme = folderRows().find((o) => o.value === 'acme')!;
    const group = acme.el.closest('[data-native-submenu]')!;
    expect(group.querySelector('[data-testid="rule-folder:work"]')).not.toBeNull();
  });

  it('gets the filter field once the list is long', () => {
    const many = Array.from({ length: 14 }, (_, i) => mailbox(`f${i}`, `Folder ${i}`, { sortOrder: i + 10 }));
    openModal({ mailboxes: [...mailboxes, ...many], initialRule: rule([{ type: 'move', value: '' }]) });
    fireEvent.click(folderButton());
    fireEvent.change(screen.getByTestId('move-filter'), { target: { value: 'acm' } });
    expect(screen.getAllByTestId(/^rule-folder:/).map((el) => el.getAttribute('data-testid'))).toEqual(['rule-folder:work', 'rule-folder:acme']);
  });

  it('still shows a hidden folder an existing rule files into', () => {
    openModal({ rule: rule([{ type: 'copy', value: 'Sent Items', mailboxId: 'sent' }]) });
    expect(folderButton().getAttribute('data-value')).toBe('sent');
    expect(folderButton()).toHaveTextContent('mailboxes.sent');
  });

  it('shows the whole path of a subfolder', () => {
    openModal({ rule: rule([{ type: 'move', value: 'Work/Acme', mailboxId: 'acme' }]) });
    expect(folderButton()).toHaveTextContent('Work / Acme');
  });

  it('still writes the server path into the rule', () => {
    const { saved } = openModal({ initialRule: rule([{ type: 'move', value: '' }]) });
    fireEvent.click(folderRows().find((o) => o.value === 'junk')!.el);
    expect(folderButton().getAttribute('data-value')).toBe('junk');
    fireEvent.click(screen.getByText('save'));
    expect(saved().actions[0]).toMatchObject({ type: 'move', mailboxId: 'junk', value: 'Junk Mail' });
  });
});

// mail-p3-9: a chip goes while the rule has its condition, and comes back
// when that row goes, so the sender chip returns after the domain replaced it.
describe('suggestion chips', () => {
  const suggestions: RuleSuggestion[] = [
    { id: 'sender', label: 'anna@acme.com', condition: { field: 'from', comparator: 'address_is', value: 'anna@acme.com' }, replaces: (c) => c.comparator === 'domain_is' },
    { id: 'domain', label: '@acme.com', condition: { field: 'from', comparator: 'domain_is', value: 'acme.com' }, replaces: (c) => c.comparator === 'address_is' },
  ];
  const prefill: FilterRule = {
    id: 'r2', name: 'Mail from anna', enabled: true, matchType: 'all',
    conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
    actions: [{ type: 'move', value: '' }], stopProcessing: true,
  };
  const chips = () => screen.queryAllByRole('group', { name: 'suggestions' })
    .flatMap((g) => [...g.querySelectorAll('button')].map((b) => b.textContent));

  it('hides the sender chip while From is the sender, and swaps sender and domain', () => {
    openModal({ initialRule: prefill, suggestions });
    expect(chips()).toEqual(['@acme.com']);
    fireEvent.click(screen.getByText('@acme.com'));
    expect(chips()).toEqual(['anna@acme.com']);
    fireEvent.click(screen.getByText('anna@acme.com'));
    expect(chips()).toEqual(['@acme.com']);
  });
});
