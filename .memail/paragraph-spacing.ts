import type { Editor } from '@tiptap/core';

export function paragraphSpacingValue(source: string | null | undefined): string {
  const style = document.createElement('p').style;
  style.cssText = source ?? '';
  return style.marginTop || '4px';
}

/** Set spacing for selected paragraphs without replacing their text or marks. */
export function setParagraphSpacing(editor: Editor, spacing: string): boolean {
  if (!['4px','1em','1.5em'].includes(spacing)) return false;
  return editor.chain().focus().command(({tr,state}) => {
    state.doc.nodesBetween(state.selection.from,state.selection.to,(node,pos)=>{
      if (node.type.name !== 'paragraph') return;
      const style = document.createElement('p').style;
      style.cssText = node.attrs.style ?? '';
      for (const key of ['margin-block','margin-block-start','margin-block-end']) style.removeProperty(key);
      style.marginTop = spacing;
      style.marginBottom = spacing;
      tr.setNodeMarkup(pos,undefined,{...node.attrs,style:style.cssText});
    });
    return true;
  }).run();
}
