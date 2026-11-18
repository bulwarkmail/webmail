import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { toast } from '@/stores/toast-store';
import { RuleEditor } from '../rule-editor';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function headerRule(headerName: string): FilterRule {
  return {
    id: 'rule-1',
    name: 'Spam flag',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'header', comparator: 'contains', value: 'yes', headerName }],
    actions: [{ type: 'discard' }],
    stopProcessing: false,
  };
}

describe('RuleEditor header names', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it.each(['X-Spam Flag', 'X-Foo.Bar', ''])('blocks saving the header name %j', (headerName) => {
    const onSave = vi.fn();
    render(<RuleEditor rule={headerRule(headerName)} mailboxes={[]} onSave={onSave} onClose={() => {}} />);

    fireEvent.click(screen.getByText('save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('validation_header_name');
    expect(screen.getByPlaceholderText('header_name').getAttribute('aria-invalid')).toBe('true');
  });

  it('saves a valid header name, trimmed', () => {
    const onSave = vi.fn();
    render(<RuleEditor rule={headerRule(' X-Spam_Flag-2 ')} mailboxes={[]} onSave={onSave} onClose={() => {}} />);

    fireEvent.click(screen.getByText('save'));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].conditions).toEqual([
      { field: 'header', comparator: 'contains', value: 'yes', headerName: 'X-Spam_Flag-2' },
    ]);
  });

  it('blocks a name typed into the header field', () => {
    const onSave = vi.fn();
    render(<RuleEditor rule={headerRule('X-Ok')} mailboxes={[]} onSave={onSave} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('header_name'), { target: { value: 'X-Mailer: Foo' } });
    fireEvent.click(screen.getByText('save'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('validation_header_name');
  });
});

describe('RuleEditor folder left out', () => {
  const mailboxes = [
    { id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 0, myRights: { mayAddItems: true } },
    { id: 'news', name: 'News', sortOrder: 1, myRights: { mayAddItems: true } },
  ] as never;
  const moveField = () => screen.getAllByRole('button', { name: 'move_to_folder' })[0];
  const copyField = () => screen.getAllByRole('button', { name: 'move_to_folder' })[1];
  const pickFolder = (field: HTMLElement, id: string) => {
    fireEvent.click(field);
    fireEvent.click(screen.getByTestId(`rule-folder:${id}`));
  };

  it('points at the folder field when Move is ticked without a folder', () => {
    vi.mocked(toast.error).mockClear();
    const onSave = vi.fn();
    render(<RuleEditor mailboxes={mailboxes} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('filter_value_placeholder'), { target: { value: 'news@example.com' } });
    fireEvent.click(screen.getByLabelText('action_types.move'));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('validation_action_folder');
    expect(moveField().getAttribute('aria-invalid')).toBe('true');

    pickFolder(moveField(), 'news');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(onSave.mock.calls[0][0].actions).toEqual([{ type: 'move', mailboxId: 'news', value: 'News' }]);
  });

  it('marks the empty condition too, and focuses the first field to fix', async () => {
    const onSave = vi.fn();
    render(<RuleEditor mailboxes={mailboxes} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('action_types.move'));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    const value = screen.getByRole('textbox', { name: 'condition_value' });
    expect(value.getAttribute('aria-invalid')).toBe('true');
    expect(moveField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'validation_empty_conditions',
      'validation_action_folder',
    ]);
    await waitFor(() => expect(document.activeElement).toBe(value));

    fireEvent.change(value, { target: { value: 'news@example.com' } });
    expect(value.getAttribute('aria-invalid')).toBe('false');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not save a copy left without its folder next to a move that has one', () => {
    const onSave = vi.fn();
    render(<RuleEditor mailboxes={mailboxes} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('filter_value_placeholder'), { target: { value: 'news@example.com' } });
    pickFolder(moveField(), 'news');
    fireEvent.click(screen.getByLabelText('action_types.copy'));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(onSave).not.toHaveBeenCalled();
    expect([moveField(), copyField()].map((f) => f.getAttribute('aria-invalid'))).toEqual(['false', 'true']);
    expect(screen.getByRole('alert').textContent).toBe('validation_action_folder');
  });
});
