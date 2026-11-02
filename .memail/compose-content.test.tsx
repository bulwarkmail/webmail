import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { RichTextEditor } from '../components/email/rich-text-editor';
import { normalizeComposeHtml, markdownToComposeHtml, looksLikeMarkdown } from './compose-content';
import { serializeEditorContent } from '../components/email/quoted-html';
async function setup() {
  let editor:Editor | undefined;
  render(<RichTextEditor content="<p></p>" onChange={()=>{}} onEditorReady={value=>{editor=value;}} />);
  await waitFor(()=>expect(editor).toBeDefined());
  return editor!;
}
const markdown = '### Project update\n\n**Bold** and *italic* with [a link](https://example.test).\n\n- One\n  - Nested\n\n| Item | Status |\n| --- | --- |\n| Build | Done |\n\n```ts\nconst ready = true;\n```'.replaceAll('\\n','\n');
describe('compose content fidelity',()=>{
  it('converts Markdown headings, nested lists, tables and fenced code through the real editor',async()=>{
    const editor = await setup();
    act(()=>{editor.commands.insertContent(markdownToComposeHtml(markdown));});
    const html = serializeEditorContent(editor);
    expect(html).toContain('<h3'); expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<table'); expect(html).toContain('<pre');
    expect(html).toContain('https://example.test'); expect(html).toContain('Nested');
  });
  it('preserves Docs typography, color, alignment and styled table cells on paste and serialization',async()=>{
    const editor = await setup();
    act(()=>{editor.view.pasteHTML('<div style="font-family:Georgia;font-size:18pt;color:#123456"><p style="text-align:center"><b>Docs title</b></p><table><tr><td style="background-color:#ffeeaa;text-align:right">Cell</td></tr></table></div>',new Event('paste') as ClipboardEvent);});
    const html = serializeEditorContent(editor);
    expect(html).toContain('Georgia'); expect(html).toContain('18pt'); expect(html).toContain('text-align: center');
    expect(html).toContain('rgb(18, 52, 86)'); expect(html).toContain('rgb(255, 238, 170)');
  });
  it('inlines simple Word class styles and turns Word list markers into lists',()=>{
    const html = normalizeComposeHtml('<style>p.MsoNormal {font-family:Calibri;font-size:11pt}</style><p class="MsoNormal">Word text</p><p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1. </span>First</p><p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">2. </span>Second</p>');
    expect(html).toContain('Calibri'); expect(html).toContain('11pt'); expect(html).toContain('<ol>');
    expect(html).not.toContain('<style'); expect(html).not.toContain('mso-list');
  });
  it('strips active HTML, unsafe CSS and private editor markers',()=>{
    const html = normalizeComposeHtml('<script>alert(1)</script><p onclick="x()" style="position:fixed;background-image:url(https://track.test)">Safe</p><a href="javascript:alert(1)">Bad</a><div data-signature-block="x">Text</div>');
    expect(html).not.toMatch(/script|onclick|position:|background-image|data-signature-block/); expect(html).toContain('Safe');
  });
  it('leaves ordinary prose out of Markdown auto-detection and renders task state as email-safe text',()=>{
    expect(looksLikeMarkdown('Hello,\n\nPlease review this.')).toBe(false);
    expect(looksLikeMarkdown('# Heading\n\n**Bold**')).toBe(true);
    expect(markdownToComposeHtml('- [x] Finished\n- [ ] Pending')).toContain('☑');
  });
});


it('auto-pastes Markdown with one undo and honors explicit plain-text paste',async()=>{
  const editor = await setup();
  const paste = () => {
    const event = new Event('paste',{bubbles:true,cancelable:true}) as ClipboardEvent;
    Object.defineProperty(event,'clipboardData',{value:{getData:(type:string)=>type==='text/plain' ? '**Clipboard bold**' : '',files:[],types:['text/plain']}});
    editor.view.dom.dispatchEvent(event);
  };
  act(paste);
  expect(editor.getHTML()).toContain('<strong>Clipboard bold</strong>');
  act(()=>{editor.commands.undo();});
  expect(editor.getText()).toBe('');
  act(()=>{fireEvent.keyDown(editor.view.dom,{key:'v',ctrlKey:true,shiftKey:true});paste();});
  expect(editor.getText()).toBe('**Clipboard bold**');
  expect(editor.getHTML()).not.toContain('<strong>');
});

it('applies font family to the selection and retains it in outgoing HTML',async()=>{
  const editor = await setup();
  act(()=>{editor.commands.setContent('<p>Font selection</p>');editor.commands.selectAll();});
  fireEvent.click(screen.getByRole('button',{name:'Font family'}));
  fireEvent.click(screen.getByRole('menuitemradio',{name:'Georgia'}));
  expect(serializeEditorContent(editor)).toContain('font-family: Georgia, serif');
});


it('preserves nested Word lists and item typography',async()=>{
  const editor = await setup();
  const html = normalizeComposeHtml('<p style="mso-list:l0 level1 lfo1;font-family:Calibri;font-size:11pt"><span style="mso-list:Ignore">1. </span>First</p><p style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">1. </span>Nested</p><p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">2. </span>Second</p>');
  act(()=>{editor.commands.setContent(html);});
  const output = document.createElement('div'); output.innerHTML = serializeEditorContent(editor);
  expect(output.querySelector('ol > li > ol > li')?.textContent).toBe('Nested');
  expect(output.querySelector('ol > li > p span')?.getAttribute('style')).toContain('Calibri');
  expect(output.querySelectorAll(':scope > ol > li')).toHaveLength(2);
});


it('offers all heading levels, tracks caret style, and returns selected blocks to normal text',async()=>{
  const editor = await setup();
  act(()=>{editor.commands.setContent('<p>Title</p><p>Body</p>');editor.commands.setTextSelection(2);});
  fireEvent.click(screen.getByRole('button',{name:'Text style'}));
  fireEvent.click(screen.getByRole('menuitemradio',{name:'Heading 4'}));
  expect(editor.getHTML()).toContain('<h4');
  expect(screen.getByRole('button',{name:'Text style'})).toHaveTextContent('Heading 4');
  act(()=>{editor.commands.setTextSelection(9);});
  expect(screen.getByRole('button',{name:'Text style'})).toHaveTextContent('Normal text');
  act(()=>{editor.commands.setTextSelection(2);});
  fireEvent.click(screen.getByRole('button',{name:'Text style'}));
  fireEvent.click(screen.getByRole('menuitemradio',{name:'Normal text'}));
  expect(editor.getHTML()).not.toContain('<h4');
});


it('preserves readable paragraph gaps in LLM HTML through paste, save and reopen',async()=>{
  const editor = await setup();
  act(()=>{editor.view.pasteHTML('<p><strong>Subject: Project next steps</strong></p><p>Hi Alex,</p><p>First full paragraph.</p><p>Second full paragraph.</p><h3>1. Ownership</h3><p>Section body.</p>',new Event('paste') as ClipboardEvent);});
  const saved = serializeEditorContent(editor);
  const document = new DOMParser().parseFromString(saved,'text/html');
  expect(Array.from(document.querySelectorAll('p')).map(p=>p.style.marginTop)).toEqual(['1em','1em','1em','1em','1em']);
  expect(document.querySelector('h3')?.style.marginTop).toBe('1.25em');
  act(()=>{editor.commands.setContent(saved);});
  expect(serializeEditorContent(editor)).toBe(saved);
});

it('keeps explicit document margins, inherited line height and compact table/list paragraphs',async()=>{
  const editor = await setup();
  act(()=>{editor.commands.setContent(normalizeComposeHtml('<div style="line-height:1.7"><p style="margin:18pt 0 12pt">Word spacing</p><p style="margin:0">No gap</p><ul><li><p>Item</p></li></ul><table><tr><td><p>Cell</p></td></tr></table></div>'));});
  const document = new DOMParser().parseFromString(serializeEditorContent(editor),'text/html');
  expect(document.querySelector('p')?.style.marginTop).toBe('18pt');
  expect(document.querySelector('p')?.style.marginBottom).toBe('12pt');
  expect(document.querySelector('p')?.style.lineHeight).toBe('1.7');
  expect(document.querySelectorAll('p')[1].style.marginTop).toBe('0px');
  expect(document.querySelector('li p')?.style.marginTop).toBe('0px');
  expect(document.querySelector('td p')?.style.marginTop).toBe('0px');
});


it('repairs selected paragraph spacing without changing text, emphasis or alignment',async()=>{
  const editor = await setup();
  act(()=>{editor.commands.setContent('<p style="text-align:right;color:#123456"><strong>Keep emphasis</strong></p><p>Leave this paragraph</p>');editor.commands.setTextSelection(3);});
  fireEvent.click(screen.getByRole('button',{name:'Paragraph spacing'}));
  fireEvent.click(screen.getByRole('menuitemradio',{name:'Comfortable'}));
  const document = new DOMParser().parseFromString(serializeEditorContent(editor),'text/html');
  expect(document.querySelector('p')?.style.marginTop).toBe('1em');
  expect(document.querySelector('p')?.style.textAlign).toBe('right');
  expect(document.querySelector('strong')?.textContent).toBe('Keep emphasis');
  expect(document.querySelectorAll('p')[1].style.marginTop).toBe('4px');
});


it('keeps paragraph indentation while supplying missing document spacing',()=>{
  const document = new DOMParser().parseFromString(normalizeComposeHtml('<p style="margin-left:24px;margin-top:0">Indented</p>'),'text/html');
  const style = document.querySelector('p')!.style;
  expect(style.marginLeft).toBe('24px');
  expect(style.marginTop).toBe('0px');
  expect(style.marginBottom).toBe('1em');
});
