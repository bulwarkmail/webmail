import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { SignatureEditor } from '../signature-editor';
import { pictureAddress } from '@/components/email/image-url-dialog';

// settings-p3-17: a signature is a few lines and maybe a logo. Its editor has the
// out-of-office toolbar (bold, italic, underline, lists, link) plus a picture by web
// address, not the composer's headings, quote, code block, alignment and table.

const toolbarItems = () =>
  Array.from(screen.getByRole('toolbar', { name: 'formatting' }).querySelectorAll<HTMLElement>('[data-toolbar-item]'))
    .map((el) => el.dataset.toolbarItem);

describe('the signature editor', () => {
  it('has the short toolbar and a Picture button', async () => {
    render(<SignatureEditor html="<p>Ann</p>" text="Ann" plainOnly={false} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'formatting' })).toBeInTheDocument());
    expect(toolbarItems()).toEqual(['bold', 'italic', 'underline', 'bullet-list', 'ordered-list', 'link', 'picture']);
  });

  it('puts a picture from a web address into the signature, with its description', async () => {
    const onChange = vi.fn();
    render(<SignatureEditor html="<p>Ann</p>" text="Ann" plainOnly={false} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'formatting' })).toBeInTheDocument());
    fireEvent.click(screen.getByTitle('button'));
    const address = await screen.findByLabelText('address');
    fireEvent.change(address, { target: { value: 'https://example.org/logo.png' } });
    fireEvent.change(screen.getByLabelText('description'), { target: { value: 'Example logo' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'insert' })); });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = onChange.mock.calls.at(-1)![0].htmlSignature as string;
    expect(html).toContain('src="https://example.org/logo.png"');
    expect(html).toContain('alt="Example logo"');
  });
});

describe('a picture address', () => {
  it('is only https with a host', () => {
    expect(pictureAddress(' https://example.org/logo.png ')).toBe('https://example.org/logo.png');
    for (const bad of ['http://example.org/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'example.org/a.png', 'https://exa mple.org', ''])
      expect(pictureAddress(bad), bad).toBeNull();
  });
});
