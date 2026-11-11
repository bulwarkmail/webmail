import { fireEvent, render, screen, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTemplateStore } from '@/stores/template-store';
import type { EmailTemplate } from '@/lib/template-types';

// The template dialogs sit on the Dialog shell (R4): close X, Escape,
// outside click, and "Discard changes?" when they hold unsaved input (R5).

const { TemplateManagerModal } = await import('../template-manager-modal');
const { PlaceholderFillModal } = await import('../placeholder-fill-modal');

const template: EmailTemplate = {
  id: 'tpl-1',
  name: 'Follow-up',
  subject: 'Hello {{recipient_name}}',
  body: 'Hi {{recipient_name}}',
  isHTML: false,
  category: '',
  isFavorite: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as EmailTemplate;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('TemplateManagerModal', () => {
  beforeEach(() => {
    useTemplateStore.setState({ templates: [template] } as never);
  });

  it('has the Dialog close X and closes on it when nothing was changed', async () => {
    const onClose = vi.fn();
    render(<TemplateManagerModal isOpen onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'title' });
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).toBeTruthy();
  });

  it('asks before the X drops a template being written, and keeps it on Keep editing', async () => {
    const onClose = vi.fn();
    render(<TemplateManagerModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    fireEvent.change(screen.getByPlaceholderText('name_placeholder'), { target: { value: 'New one' } });

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'discard_changes' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'keep_editing' }));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText('name_placeholder') as HTMLInputElement).value).toBe('New one');
  });

  it('ignores a click outside while the form holds changes', async () => {
    const onClose = vi.fn();
    render(<TemplateManagerModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    fireEvent.change(screen.getByPlaceholderText('name_placeholder'), { target: { value: 'x' } });
    const backdrop = screen.getByTestId('template-manager').parentElement!;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before deleting a template instead of an inline Delete strip', async () => {
    render(<TemplateManagerModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await flush();
    const confirm = screen.getByRole('alertdialog', { name: 'delete_title' });
    expect(useTemplateStore.getState().templates).toHaveLength(1);
    fireEvent.click(confirm.querySelector('button.bg-destructive') as HTMLElement);
    await flush();
    expect(useTemplateStore.getState().templates).toHaveLength(0);
  });

  it('names its row buttons', () => {
    render(<TemplateManagerModal isOpen onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'duplicate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'favorite' })).toBeTruthy();
  });
});

describe('PlaceholderFillModal', () => {
  function renderFill(onClose = vi.fn()) {
    render(
      <PlaceholderFillModal
        template={template}
        placeholders={['recipient_name']}
        autoFilled={{}}
        onConfirm={vi.fn()}
        onSkip={vi.fn()}
        onClose={onClose}
      />,
    );
    return onClose;
  }

  it('closes on Escape at once while nothing was typed', async () => {
    const onClose = renderFill();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'fill_placeholders' }), { key: 'Escape' });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before Escape drops typed values', async () => {
    const onClose = renderFill();
    fireEvent.change(screen.getByPlaceholderText('enter_value'), { target: { value: 'Ada' } });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'fill_placeholders' }), { key: 'Escape' });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'discard' }));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts a field with the auto-filled value or the template default, selected on focus until changed', () => {
    const onConfirm = vi.fn();
    render(
      <PlaceholderFillModal
        template={{ ...template, body: 'Hi {{recipient_name:Ada}}, see you at {{time:15:00}}' }}
        placeholders={['recipient_name', 'time']}
        autoFilled={{ recipient_name: 'Grace' }}
        onConfirm={onConfirm}
        onSkip={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const [name, time] = screen.getAllByPlaceholderText('enter_value') as HTMLInputElement[];
    expect(name.value).toBe('Grace');
    expect(time.value).toBe('15:00');

    name.setSelectionRange(5, 5);
    fireEvent.focus(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 5]);

    time.setSelectionRange(5, 5);
    fireEvent.focus(time);
    expect([time.selectionStart, time.selectionEnd]).toEqual([0, 5]);

    fireEvent.change(time, { target: { value: '17:00' } });
    time.setSelectionRange(5, 5);
    fireEvent.focus(time);
    expect([time.selectionStart, time.selectionEnd]).toEqual([5, 5]);

    fireEvent.click(screen.getByRole('button', { name: 'insert_with_values' }));
    expect(onConfirm).toHaveBeenCalledWith({ recipient_name: 'Grace', time: '17:00' });
  });

  it('selects the first field\'s default when the dialog opens, so typing replaces it', async () => {
    render(
      <PlaceholderFillModal
        template={{ ...template, body: 'See you at {{time:15:00}}' }}
        placeholders={['time']}
        autoFilled={{}}
        onConfirm={vi.fn()}
        onSkip={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flush();
    const time = screen.getByPlaceholderText('enter_value') as HTMLInputElement;
    expect(document.activeElement).toBe(time);
    expect([time.selectionStart, time.selectionEnd]).toEqual([0, 5]);
  });

  it('puts an HTML template\'s default in as text, not markup', () => {
    const onConfirm = vi.fn();
    render(
      <PlaceholderFillModal
        template={{ ...template, isHTML: true, body: '<p>Hi {{name:&lt;img src=x onerror=alert(1)&gt;}}</p>' }}
        placeholders={['name']}
        autoFilled={{}}
        onConfirm={onConfirm}
        onSkip={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'fill_placeholders' });
    expect((screen.getByPlaceholderText('enter_value') as HTMLInputElement).value).toBe('<img src=x onerror=alert(1)>');
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.textContent).toContain('Hi <img src=x onerror=alert(1)>');

    fireEvent.click(screen.getByRole('button', { name: 'insert_with_values' }));
    expect(onConfirm).toHaveBeenCalledWith({ name: '<img src=x onerror=alert(1)>' });
  });

  it('has an outline secondary button and the close X', () => {
    renderFill();
    expect(screen.getByRole('button', { name: 'insert_raw' }).className).toContain('border-input');
    expect(screen.getByRole('button', { name: 'close' })).toBeTruthy();
  });
});
