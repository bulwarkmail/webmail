import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PromptDialog } from '../prompt-dialog';

// A fixed suffix after the field, such as the extension of a file being
// renamed: shown, not editable, checked with the value, and left to the
// caller to add back.

function renderDialog(validate?: (value: string) => string | null) {
  const onSubmit = vi.fn();
  render(
    <PromptDialog isOpen onClose={vi.fn()} onSubmit={onSubmit} title="Rename" defaultValue="report" suffix=".pdf" confirmText="Save" validate={validate} />,
  );
  return { onSubmit, input: screen.getByRole('textbox', { name: 'Rename' }) as HTMLInputElement };
}

describe('PromptDialog with a suffix', () => {
  it('shows the suffix after the field, outside it', () => {
    const { input } = renderDialog();
    expect(screen.getByTestId('prompt-suffix')).toHaveTextContent('.pdf');
    expect(input.value).toBe('report');
  });

  it('submits the value without the suffix', () => {
    const { onSubmit, input } = renderDialog();
    fireEvent.change(input, { target: { value: '  Q3 report ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith('Q3 report');
  });

  it('validates the value with the suffix', () => {
    const validate = vi.fn((value: string) => (value.endsWith('.pdf') && value.includes('/') ? 'no slashes' : null));
    const { onSubmit, input } = renderDialog(validate);
    fireEvent.change(input, { target: { value: 'a/b' } });
    expect(validate).toHaveBeenLastCalledWith('a/b.pdf');
    expect(screen.getByRole('alert')).toHaveTextContent('no slashes');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows no suffix when none is given', () => {
    render(<PromptDialog isOpen onClose={vi.fn()} onSubmit={vi.fn()} title="Rename" defaultValue="README" />);
    expect(screen.queryByTestId('prompt-suffix')).toBeNull();
  });
});
