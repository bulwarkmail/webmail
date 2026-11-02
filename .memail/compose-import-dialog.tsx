'use client';
import { useId, useRef, useState } from 'react';
import { Dialog } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { markdownToComposeHtml, normalizeComposeHtml, plainTextToComposeHtml } from './compose-content';
import { composePreviewDocument } from './compose-preview';

export const MAX_COMPOSE_IMPORT_BYTES = 1024 * 1024;

export function ComposeImportDialog({onClose,onInsert}: {onClose:()=>void;onInsert:(html:string)=>void}) {
  const [format,setFormat] = useState('markdown');
  const [source,setSource] = useState('');
  const [preview,setPreview] = useState<string | null>(null);
  const [phone,setPhone] = useState(false);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileVersion = useRef(0);
  const id = useId();
  const convert = () => format === 'markdown' ? markdownToComposeHtml(source) : format === 'text' ? plainTextToComposeHtml(source) : normalizeComposeHtml(source);
  const invalidate = () => { fileVersion.current++; setLoading(false); setPreview(null); setError(''); };
  const importFile = async (file:File | undefined) => {
    if (!file) return;
    invalidate();
    const version = fileVersion.current;
    if (!/\.(md|markdown|html?|txt)$/i.test(file.name)) { setError('Choose a Markdown, HTML or plain text file.'); return; }
    if (file.size > MAX_COMPOSE_IMPORT_BYTES) { setError('Choose a file smaller than 1 MB.'); return; }
    setLoading(true);
    try {
      const content = await file.text();
      if (version !== fileVersion.current) return;
      setSource(content);
      setFormat(/\.html?$/i.test(file.name) ? 'html' : /\.txt$/i.test(file.name) ? 'text' : 'markdown');
    } catch {
      if (version === fileVersion.current) setError('This file could not be read. You can paste its content instead.');
    } finally {
      if (version === fileVersion.current) setLoading(false);
    }
  };
  const close = () => { fileVersion.current++; onClose(); };
  return <Dialog isOpen onClose={close} title="Insert formatted content" size="lg" preventOutsideClose
    description="Write or import Markdown and HTML, review it, then insert it into your message."
    footer={<>
      <Button variant="outline" onClick={close}>Cancel</Button>
      <Button disabled={!source.trim() || loading} onClick={()=>{onInsert(convert());close();}}>Insert content</Button>
    </>}>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="min-w-40 flex-1">
        <label htmlFor={`${id}-format`} className="text-sm font-medium">Source format</label>
        <select id={`${id}-format`} value={format} onChange={e=>{invalidate();setFormat(e.target.value);}}
          className="mt-2 block min-h-11 w-full rounded-md border border-input bg-background px-3">
          <option value="markdown">Markdown</option><option value="html">HTML</option><option value="text">Plain text</option>
        </select>
      </div>
      <input ref={fileInput} type="file" tabIndex={-1} className="hidden" aria-label="Import content file"
        accept=".md,.markdown,.html,.htm,.txt" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value='';}} />
      <Button variant="outline" onClick={()=>fileInput.current?.click()}>Import file</Button>
    </div>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1" role="group" aria-label="Content view">
        <Button variant={preview === null ? 'default' : 'outline'} aria-pressed={preview === null} onClick={()=>setPreview(null)}>Source</Button>
        <Button variant={preview !== null ? 'default' : 'outline'} aria-pressed={preview !== null}
          disabled={!source.trim() || loading} onClick={()=>setPreview(composePreviewDocument(convert()))}>Preview</Button>
      </div>
      {preview !== null && <Button variant="outline" aria-pressed={phone} onClick={()=>setPhone(value=>!value)}>Phone width</Button>}
    </div>
    {preview === null ? <>
      <label htmlFor={id} className="text-sm font-medium">Content</label>
      <textarea id={id} value={source} onChange={e=>{invalidate();setSource(e.target.value);}}
        className="mt-2 min-h-64 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-sm"
        placeholder={format==='markdown' ? '# Heading\n\n**Bold**, lists, tables, links and code' : format==='html' ? '<h2>Heading</h2><p>Formatted content</p>' : 'Plain text, with line breaks preserved'} />
    </> : <div className="rounded-lg border border-border bg-muted p-2">
      <iframe title="Formatted content preview" sandbox="" referrerPolicy="no-referrer" srcDoc={preview}
        className={`mx-auto block h-80 max-w-full rounded bg-white ${phone ? 'w-[375px]' : 'w-full'}`} />
    </div>}
    {loading && <p role="status" className="mt-2 text-sm">Reading file…</p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Content stays editable after insertion. Preview blocks remote images and links. Email apps may render spacing and fonts differently.</p>
  </Dialog>;
}
