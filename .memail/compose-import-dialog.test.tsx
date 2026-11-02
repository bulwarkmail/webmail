import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposeImportDialog, MAX_COMPOSE_IMPORT_BYTES } from './compose-import-dialog';

function setup() {
  const onInsert = vi.fn(); const onClose = vi.fn();
  render(<ComposeImportDialog onInsert={onInsert} onClose={onClose} />);
  return {onInsert,onClose};
}

describe('formatted content review',()=>{
  it('previews sanitized Markdown in an isolated frame without inserting until requested',()=>{
    const {onInsert,onClose} = setup();
    fireEvent.change(screen.getByLabelText('Content',{exact:true}),{target:{value:'# Review\n\n**Ready** [link](https://example.test)'}});
    fireEvent.click(screen.getByRole('button',{name:'Preview'}));
    const frame = screen.getByTitle('Formatted content preview');
    expect(frame).toHaveAttribute('sandbox','');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(frame.getAttribute('srcdoc')).toContain('<strong>Ready</strong>');
    expect(frame.getAttribute('srcdoc')).not.toContain('href=');
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Phone width'}));
    expect(frame).toHaveClass('w-[375px]');
    fireEvent.click(screen.getByRole('button',{name:'Source'}));
    expect(screen.getByLabelText('Content',{exact:true})).toHaveValue('# Review\n\n**Ready** [link](https://example.test)');
    fireEvent.click(screen.getByRole('button',{name:'Insert content'}));
    expect(onInsert.mock.calls[0][0]).toContain('href="https://example.test"');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('imports local HTML, strips executable content and leaves the source available',async()=>{
    const {onInsert} = setup();
    const file = new File([''], 'proposal.html',{type:'text/html'});
    Object.defineProperty(file,'text',{value:async()=>'<h3>Proposal</h3><script>bad()</script><p onclick="bad()">Safe</p>'});
    fireEvent.change(screen.getByLabelText('Import content file'),{target:{files:[file]}});
    await waitFor(()=>expect(screen.getByLabelText('Source format')).toHaveValue('html'));
    fireEvent.click(screen.getByRole('button',{name:'Insert content'}));
    expect(new DOMParser().parseFromString(onInsert.mock.calls[0][0],'text/html').querySelector('h3')?.textContent).toBe('Proposal');
    expect(onInsert.mock.calls[0][0]).not.toMatch(/script|onclick/);
  });

  it('rejects oversized and unsupported files without replacing current text',()=>{
    setup();
    fireEvent.change(screen.getByLabelText('Content',{exact:true}),{target:{value:'Keep this draft'}});
    const file = new File([''], 'large.md');
    Object.defineProperty(file,'size',{value:MAX_COMPOSE_IMPORT_BYTES+1});
    fireEvent.change(screen.getByLabelText('Import content file'),{target:{files:[file]}});
    expect(screen.getByRole('alert')).toHaveTextContent('smaller than 1 MB');
    expect(screen.getByLabelText('Content',{exact:true})).toHaveValue('Keep this draft');
    fireEvent.change(screen.getByLabelText('Import content file'),{target:{files:[new File([''],'document.docx')]}});
    expect(screen.getByRole('alert')).toHaveTextContent('Markdown, HTML or plain text');
  });

  it('does not overwrite new typing when an earlier file read completes',async()=>{
    setup();
    let complete!:(text:string)=>void;
    const file = new File([''],'slow.md');
    Object.defineProperty(file,'text',{value:()=>new Promise<string>(resolve=>{complete=resolve;})});
    fireEvent.change(screen.getByLabelText('Import content file'),{target:{files:[file]}});
    fireEvent.change(screen.getByLabelText('Content',{exact:true}),{target:{value:'Newer text'}});
    await act(async()=>{complete('Older file');});
    expect(screen.getByLabelText('Content',{exact:true})).toHaveValue('Newer text');
  });
});


it('inserts plain text literally, preserving blank lines',()=>{
  const {onInsert} = setup();
  fireEvent.change(screen.getByLabelText('Source format'),{target:{value:'text'}});
  fireEvent.change(screen.getByLabelText('Content',{exact:true}),{target:{value:'**Literal**\n\n<script>not code</script>'}});
  fireEvent.click(screen.getByRole('button',{name:'Insert content'}));
  expect(onInsert.mock.calls[0][0]).toBe('<p>**Literal**</p><p><br></p><p>&lt;script&gt;not code&lt;/script&gt;</p>');
});
