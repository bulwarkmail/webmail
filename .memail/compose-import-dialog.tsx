'use client';
import { useId, useState } from 'react';
import { Dialog } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { markdownToComposeHtml, normalizeComposeHtml } from './compose-content';
export function ComposeImportDialog({onClose,onInsert}: {onClose:()=>void;onInsert:(html:string)=>void}) {
  const [format,setFormat] = useState('markdown');
  const [source,setSource] = useState('');
  const id = useId();
  return <Dialog isOpen onClose={onClose} title="Insert formatted content" size="lg" preventOutsideClose description="Paste Markdown or HTML source. Inserted content remains editable in your message." footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!source.trim()} onClick={()=>{onInsert(format==='markdown' ? markdownToComposeHtml(source) : normalizeComposeHtml(source));onClose();}}>Insert content</Button></>}>
    <label htmlFor={`${id}-format`} className="text-sm font-medium">Source format</label>
    <select id={`${id}-format`} value={format} onChange={e=>setFormat(e.target.value)} className="mb-4 mt-2 block min-h-11 w-full rounded-md border border-input bg-background px-3"><option value="markdown">Markdown</option><option value="html">HTML</option></select>
    <label htmlFor={id} className="text-sm font-medium">Content</label>
    <textarea id={id} value={source} onChange={e=>setSource(e.target.value)} className="mt-2 min-h-64 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-sm" placeholder={format==='markdown' ? '# Heading\n\n**Bold**, lists, tables, links and code' : '<h2>Heading</h2><p>Formatted content</p>'} />
    <p className="mt-2 text-xs text-muted-foreground">Document formatting is converted to email HTML. Scripts and embedded apps are removed. Fonts use fallbacks on devices where they are unavailable.</p>
  </Dialog>;
}
