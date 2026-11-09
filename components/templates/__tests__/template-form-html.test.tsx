import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TemplateForm } from '../template-form';

// A template saved from a rich text draft is HTML: the form shows it in the
// composer's editor with HTML ticked, never as source in a text box (#1506).

const draftHtml = '<p>Hello <strong>team</strong></p><p>See you</p>';

function editingArea() {
  return document.querySelector('[data-testid="template-body-editor"] .ProseMirror') as HTMLElement | null;
}

describe('TemplateForm body format (#1506)', () => {
  it('opens a rich text draft in the rich editor, with HTML ticked', async () => {
    const onSave = vi.fn();
    render(<TemplateForm initialData={{ body: draftHtml, isHTML: true }} onSave={onSave} onCancel={vi.fn()} />);

    await waitFor(() => expect(editingArea()).toBeTruthy());
    expect(editingArea()!.textContent).toContain('Hello team');
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.getByRole('button', { name: 'HTML' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByPlaceholderText('name_placeholder'), { target: { value: 'Weekly' } });
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ isHTML: true, body: expect.stringContaining('<strong>team</strong>') }));
  });

  it('keeps a plain text draft in the text box', () => {
    render(<TemplateForm initialData={{ body: 'Hello team', isHTML: false }} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Hello team');
    expect(editingArea()).toBeNull();
  });

  it('converts the body when HTML is switched on and off', async () => {
    const onSave = vi.fn();
    render(<TemplateForm onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Hi <you>\n\nBye' } });

    fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
    await waitFor(() => expect(editingArea()).toBeTruthy());
    // The text is shown as text: the angle brackets were escaped, not parsed.
    expect(editingArea()!.textContent).toContain('Hi <you>');
    expect(editingArea()!.querySelectorAll('p').length).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).not.toContain('<p>');
    expect(textarea.value).toContain('Hi <you>');
    expect(textarea.value).toContain('Bye');
  });

  it('keeps an existing HTML template in the rich editor when edited', async () => {
    render(
      <TemplateForm
        template={{ id: 't', name: 'Old', subject: '', body: draftHtml, isHTML: true, category: '', isFavorite: false, createdAt: '', updatedAt: '' }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(editingArea()).toBeTruthy());
    expect(document.querySelector('textarea')).toBeNull();
  });
});
