import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';

const TYPOGRAPHY = ['font-family','font-size','font-weight','font-style','font-variant','color','background','background-color','text-align','text-decoration','text-decoration-line','letter-spacing','line-height'];

/** Clear pasted block styles as well as inline marks, retaining spacing and content. */
export function clearComposeFormatting(editor:Editor): boolean {
  const originalStyles = new Map<number,string>();
  editor.state.doc.nodesBetween(editor.state.selection.from,editor.state.selection.to,(node,pos)=>{
    if(['paragraph','heading','tableCell','tableHeader'].includes(node.type.name)) originalStyles.set(pos,node.attrs.style ?? '');
  });
  return editor.chain().focus().command(({tr})=>{closeHistory(tr);return true;}).clearNodes().unsetAllMarks().command(({tr})=>{
    const preserved = new Map(Array.from(originalStyles,([pos,style])=>[tr.mapping.map(pos),style]));
    tr.doc.nodesBetween(tr.selection.from,tr.selection.to,(node,pos)=>{
      if (!['paragraph','heading','tableCell','tableHeader'].includes(node.type.name)) return;
      const style = document.createElement('span').style;
      style.cssText = preserved.get(pos) ?? node.attrs.style ?? '';
      TYPOGRAPHY.forEach(key=>style.removeProperty(key));
      tr.setNodeMarkup(pos,undefined,{...node.attrs,style:style.cssText || null,...('textAlign' in node.attrs ? {textAlign:null} : {})});
    });
    return true;
  }).run();
}

/** Line height applies to selected paragraphs; existing font/color marks survive. */
export function setComposeLineHeight(editor:Editor,value:string): boolean {
  if (!['','1.15','1.5','1.75','2'].includes(value)) return false;
  return editor.chain().focus().command(({tr})=>{
    closeHistory(tr);
    tr.doc.nodesBetween(tr.selection.from,tr.selection.to,(node,pos)=>{
      if (!['paragraph','heading'].includes(node.type.name)) return;
      const style = document.createElement('span').style;
      style.cssText = node.attrs.style ?? '';
      if(value) style.lineHeight=value; else style.removeProperty('line-height');
      tr.setNodeMarkup(pos,undefined,{...node.attrs,style:style.cssText || null});
      // An imported span's line height would otherwise override the block.
      node.descendants((child,offset)=>{
        if(!child.isText) return;
        const mark = child.marks.find(mark=>mark.type.name==='textStyle' && mark.attrs.lineHeight);
        if(!mark) return;
        const from=pos+1+offset; const to=from+child.nodeSize;
        tr.removeMark(from,to,mark.type);
        tr.addMark(from,to,mark.type.create({...mark.attrs,lineHeight:null}));
      });
    });
    return true;
  }).run();
}

export function composeLineHeightValue(editor:Editor): string {
  const attrs = editor.isActive('heading') ? editor.getAttributes('heading') : editor.getAttributes('paragraph');
  const style = document.createElement('span').style;
  style.cssText=attrs.style ?? '';
  return style.lineHeight;
}
