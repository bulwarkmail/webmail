import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { Mailbox } from '@/lib/jmap/types';
import { FilterRuleModal } from '../filter-rule-modal';

// settings-13 and settings-9 (usability pass 2026-11-04): one way to stop
// later rules, and a folder picker that names folders as the sidebar does.

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

function mailbox(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: {} as Mailbox['myRights'], isSubscribed: true, isShared: false, ...extra,
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
const folderSelect = () => screen.getByLabelText('move_to_folder') as HTMLSelectElement;
const folderOptions = () => [...folderSelect().options].map((o) => ({ value: o.value, text: o.textContent ?? '' }));
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

describe('the folder picker of Move to folder', () => {
  it('names role folders as the sidebar does and leaves out Drafts, Sent and Scheduled', () => {
    openModal({ initialRule: rule([{ type: 'move', value: '' }]) });
    const texts = folderOptions().map((o) => o.text.trim());
    expect(texts).toContain('mailboxes.inbox');
    expect(texts).toContain('mailboxes.spam');
    expect(texts).toContain('mailboxes.trash');
    for (const hidden of ['Sent Items', 'Junk Mail', 'Deleted Items', 'mailboxes.sent', 'mailboxes.drafts', 'Drafts', 'Scheduled']) {
      expect(texts).not.toContain(hidden);
    }
  });

  it('indents subfolders under their parent', () => {
    openModal({ initialRule: rule([{ type: 'move', value: '' }]) });
    const options = folderOptions();
    const work = options.findIndex((o) => o.value === 'work');
    const acme = options.findIndex((o) => o.value === 'acme');
    expect(acme).toBe(work + 1);
    expect(options[acme].text.startsWith(' ')).toBe(true);
  });

  it('still shows a hidden folder an existing rule files into', () => {
    openModal({ rule: rule([{ type: 'copy', value: 'Sent Items', mailboxId: 'sent' }]) });
    expect(folderSelect().value).toBe('sent');
    expect(folderOptions().map((o) => o.value)).toContain('sent');
  });

  it('still writes the server path into the rule', () => {
    const { saved } = openModal({ initialRule: rule([{ type: 'move', value: '' }]) });
    fireEvent.change(folderSelect(), { target: { value: 'junk' } });
    fireEvent.click(screen.getByText('save'));
    expect(saved().actions[0]).toMatchObject({ type: 'move', mailboxId: 'junk', value: 'Junk Mail' });
  });
});
