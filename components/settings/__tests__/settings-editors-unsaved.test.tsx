import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterRuleModal } from '@/components/filters/filter-rule-modal';
import { SieveEditorModal } from '@/components/filters/sieve-editor-modal';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';

// R5: the identity, filter rule and Sieve editors ask "Discard changes?"
// before dropping what was typed, whatever closes them, and ignore a click
// outside while they hold unsaved input. R4: they render in a portal on
// <body>, so their backdrop covers the whole window.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

/** The dimmed backdrop around the open dialog. */
function backdrop(): HTMLElement {
  const dialogs = screen.getAllByRole('dialog');
  return dialogs[dialogs.length - 1].parentElement as HTMLElement;
}

function clickOutside() {
  const el = backdrop();
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

describe('filter rule dialog', () => {
  it('closes on Escape without asking while nothing was typed', async () => {
    const onClose = vi.fn();
    render(<FilterRuleModal mailboxes={[]} onSave={vi.fn()} onClose={onClose} />);
    pressEscape();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'discard' })).toBeNull();
  });

  it('ignores a click outside and asks before Escape drops a typed name', async () => {
    const onClose = vi.fn();
    render(<FilterRuleModal mailboxes={[]} onSave={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText('rule_name_placeholder'), { target: { value: 'Newsletters' } });

    clickOutside();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Newsletters')).toBeTruthy();

    pressEscape();
    fireEvent.click(await screen.findByRole('button', { name: 'keep_editing' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Newsletters')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'discard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('renders in a portal on body', () => {
    const { container } = render(<FilterRuleModal mailboxes={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.getByRole('dialog').closest('body')).toBe(document.body);
  });
});

describe('Sieve editor', () => {
  it('asks before Escape drops an edited script, and ignores a click outside', async () => {
    const onClose = vi.fn();
    render(<SieveEditorModal content="keep;" onSave={vi.fn()} onClose={onClose} onValidate={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep;\nstop;' } });

    clickOutside();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape();
    fireEvent.click(await screen.findByRole('button', { name: 'discard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('identity dialog', () => {
  const initial = { auth: useAuthStore.getState(), identity: useIdentityStore.getState() };
  beforeEach(() => {
    useAuthStore.setState({ client: null, refreshIdentities: vi.fn(), syncIdentities: vi.fn() } as never);
    useIdentityStore.setState({ identities: [] } as never);
  });
  afterEach(() => {
    useAuthStore.setState(initial.auth, true);
    useIdentityStore.setState(initial.identity, true);
  });

  it('keeps a half-filled new identity through a click outside and asks on Escape', async () => {
    const onClose = vi.fn();
    render(
      <div>
        <IdentityManagerModal isOpen onClose={onClose} />
      </div>,
    );
    // In a portal on body, not inside the settings page.
    expect(screen.getByRole('dialog').parentElement?.parentElement).toBe(document.body);

    // "Add address" and "Your name" (settings-p2-2, p2-3), no placeholder.
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Work' } });

    clickOutside();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Work')).toBeTruthy();

    // Escape closes the form first, after asking; the dialog stays open.
    pressEscape();
    fireEvent.click(await screen.findByRole('button', { name: 'discard' }));
    await waitFor(() => expect(screen.queryByDisplayValue('Work')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    // Nothing typed any more: Escape closes the dialog.
    act(() => { pressEscape(); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
