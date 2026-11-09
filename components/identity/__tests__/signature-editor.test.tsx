import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { IdentityForm } from '../identity-form';
import { useSettingsStore } from '@/stores/settings-store';
import type { Identity } from '@/lib/jmap/types';

// The signature in the identity editor: one field with the composer's
// formatting editor, its plain-text part generated, "Edit as HTML" only with
// advanced settings on, a size line only near the server's limit, and a
// plain text box for someone who writes plain text only.

// The editor hands the form its HTML as typed.
vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (html: string) => void }) => (
    <textarea data-testid="signature-rich-editor" value={content} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const ANN = { id: 'id-ann', name: 'Ann', email: 'ann@example.org', mayDelete: true, textSignature: '', htmlSignature: '' } as Identity;

const editor = () => screen.getByTestId('signature-rich-editor') as HTMLTextAreaElement;
const submit = () => fireEvent.submit(document.getElementById('identity-name')!.closest('form')!);

afterEach(() => {
  useSettingsStore.setState({ showAdvancedSettings: false, plainTextMode: false });
});

describe('the signature field', () => {
  it('is one formatted field, and a save sends the HTML with a plain text made from it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IdentityForm identity={ANN} onSave={onSave} onCancel={() => {}} />);
    // No box for typing HTML, and no second text box.
    expect(screen.queryByLabelText('html_signature_label')).toBeNull();
    expect(screen.queryByLabelText('text_signature_label')).toBeNull();
    expect(screen.getByText('signature_label')).toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: '<p>Ann Lee</p><p><a href="https://ann.example">ann.example</a></p>' } });
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const sent = onSave.mock.calls[0][0];
    expect(sent.htmlSignature).toBe('<p>Ann Lee</p><p><a href="https://ann.example">ann.example</a></p>');
    expect(sent.textSignature).toMatch(/^Ann Lee\s+ann\.example/);
  });

  it('opens a text-only signature in the editor', () => {
    render(<IdentityForm identity={{ ...ANN, textSignature: 'Cheers,\nAnn' }} onSave={vi.fn()} onCancel={() => {}} />);
    expect(editor().value).toBe('<p>Cheers,<br>Ann</p>');
  });

  it('offers Edit as HTML only with advanced settings on', async () => {
    const { unmount } = render(<IdentityForm identity={{ ...ANN, htmlSignature: '<p>Ann</p>' }} onSave={vi.fn()} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: 'edit_as_html' })).toBeNull();
    unmount();

    useSettingsStore.setState({ showAdvancedSettings: true });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IdentityForm identity={{ ...ANN, htmlSignature: '<p>Ann</p>' }} onSave={onSave} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'edit_as_html' }));
    const source = screen.getByLabelText('html_source_label') as HTMLTextAreaElement;
    expect(source.value).toBe('<p>Ann</p>');
    fireEvent.change(source, { target: { value: '<p>Ann <i>Lee</i></p>' } });
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ htmlSignature: '<p>Ann <i>Lee</i></p>', textSignature: expect.stringMatching(/^Ann\s+Lee$/) });
  });

  it('shows the size only near the server limit, and will not save a signature that is too long', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IdentityForm identity={ANN} onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(editor(), { target: { value: '<p>Ann</p>' } });
    expect(screen.queryByTestId('signature-size')).toBeNull();

    fireEvent.change(editor(), { target: { value: `<p>${'a'.repeat(1900)}</p>` } });
    expect(screen.getByTestId('signature-size').textContent).toMatch(/^signature_size/);

    fireEvent.change(editor(), { target: { value: `<p>${'a'.repeat(2100)}</p>` } });
    expect(screen.getByTestId('signature-size').textContent).toMatch(/^signature_too_long/);
    submit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('is a plain text box for someone who writes plain text only, and keeps the HTML version', async () => {
    useSettingsStore.setState({ plainTextMode: true });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<IdentityForm identity={{ ...ANN, htmlSignature: '<p><b>Ann</b></p>', textSignature: 'Ann' }} onSave={onSave} onCancel={() => {}} />);
    expect(screen.queryByTestId('signature-rich-editor')).toBeNull();
    const box = screen.getByLabelText('signature_plain_label') as HTMLTextAreaElement;
    expect(box.value).toBe('Ann');
    fireEvent.change(box, { target: { value: 'Ann Lee' } });
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ textSignature: 'Ann Lee', htmlSignature: '<p><b>Ann</b></p>' });
  });
});
