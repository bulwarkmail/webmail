import { marked } from 'marked';
import { sanitizeEmailHtml } from '../lib/email-sanitization';

const STYLE_KEYS = ['font-family','font-size','font-weight','font-style','text-decoration','color','background-color','text-align','line-height','letter-spacing','white-space','vertical-align','border','border-color','border-width','border-style','padding','padding-left','padding-right','padding-top','padding-bottom','margin','margin-top','margin-bottom','margin-left','margin-right','margin-block','margin-block-start','margin-block-end','width','height'];
const INLINE_KEYS = ['font-family','font-size','font-weight','font-style','text-decoration','color','background-color'];
function safeStyles(source: string): string {
  const style = document.createElement('span').style;
  style.cssText = source;
  return Array.from({length:style.length},(_,index)=>style.item(index)).filter(key=>STYLE_KEYS.includes(key)).flatMap(key => {
    const value = style.getPropertyValue(key);
    return value && !/url\s*\(|expression\s*\(|[<>\\]/i.test(value) ? [`${key}:${value}`] : [];
  }).join(';');
}
/** Inert clipboard normalization: no source CSS or executable HTML enters the app. */
export function normalizeComposeHtml(source: string): string {
  const template = document.createElement('template');
  template.innerHTML = source;
  const root = template.content;
  // Word often stores basic font rules in class selectors instead of inline.
  // Only simple element/class selectors and safe formatting declarations survive.
  for (const sheet of root.querySelectorAll('style')) {
    for (const rule of (sheet.textContent ?? '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const style = safeStyles(rule[2]);
      if (!style) continue;
      for (const selector of rule[1].split(',').map(s => s.trim())) {
        if (!/^(?:[a-z][\w-]*)?(?:\.[\w-]+)*$/i.test(selector) || !selector) continue;
        for (const element of root.querySelectorAll<HTMLElement>(selector)) {
          element.setAttribute('style',`${style};${element.getAttribute('style') ?? ''}`);
        }
      }
    }
    sheet.remove();
  }
  // Word's list paragraphs use mso-list and decorative marker spans.
  // Convert adjacent items to semantic lists before stripping Office styles.
  for (const first of Array.from(root.querySelectorAll<HTMLParagraphElement>('p'))) {
    if (!first.parentNode || !/mso-list\s*:/i.test(first.getAttribute('style') ?? '')) continue;
    const firstLevel = Number(/level(\d+)/i.exec(first.getAttribute('style') ?? '')?.[1] ?? 1);
    const ordered = /^\s*\d+[.)]/.test(first.textContent ?? '');
    const list = document.createElement(ordered ? 'ol' : 'ul');
    const startNumber = /^\s*(\d+)/.exec(first.textContent ?? '')?.[1];
    if (ordered && startNumber && startNumber !== '1') list.setAttribute('start',startNumber);
    first.before(list);
    const stack: {level:number;list:HTMLElement}[] = [{level:firstLevel,list}];
    let current: Element | null = first;
    while (current?.tagName === 'P' && /mso-list\s*:/i.test(current.getAttribute('style') ?? '')) {
      const next: Element | null = current.nextElementSibling;
      const level = Number(/level(\d+)/i.exec(current.getAttribute('style') ?? '')?.[1] ?? firstLevel);
      while (stack.length > 1 && level < stack[stack.length-1].level) stack.pop();
      let target = stack[stack.length-1];
      if (level > target.level && target.list.lastElementChild) {
        const nested = document.createElement(/^\s*\d+[.)]/.test(current.textContent ?? '') ? 'ol' : 'ul');
        target.list.lastElementChild.append(nested);
        target = {level,list:nested}; stack.push(target);
      }
      for (const marker of current.querySelectorAll<HTMLElement>('[style]')) if (/mso-list\s*:\s*ignore/i.test(marker.getAttribute('style') ?? '')) marker.remove();
      const li = document.createElement('li');
      const paragraph = document.createElement('p');
      paragraph.setAttribute('style',safeStyles(current.getAttribute('style') ?? ''));
      paragraph.append(...Array.from(current.childNodes)); li.append(paragraph);
      target.list.append(li); current.remove(); current = next;
    }
  }

  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) input.replaceWith(document.createTextNode(input.hasAttribute('checked') ? '☑ ' : '☐ '));
  for (const font of root.querySelectorAll('font')) {
    const span = document.createElement('span');
    if (font.getAttribute('face')) span.style.fontFamily = font.getAttribute('face')!;
    if (font.getAttribute('color')) span.style.color = font.getAttribute('color')!;
    span.append(...Array.from(font.childNodes)); font.replaceWith(span);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[style]')) {
    const safe = safeStyles(el.getAttribute('style') ?? '');
    if (safe) el.setAttribute('style',safe); else el.removeAttribute('style');
  }
  // Clipboard fragments from LLMs often contain semantic paragraphs but no
  // stylesheet. Materialize their normal document spacing before the editor's
  // compact typed-line defaults can replace it. Explicit source margins win.
  for (const block of root.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6')) {
    if (!block.textContent?.trim() && !block.querySelector('img')) continue;
    const compact = !!block.closest('td,th,li');
    if (!block.style.marginTop && !block.style.marginBlock && !block.style.marginBlockStart) {
      block.style.marginTop = compact ? '0' : block.tagName === 'P' ? '1em' : '1.25em';
    }
    if (!block.style.marginBottom && !block.style.marginBlock && !block.style.marginBlockEnd) {
      block.style.marginBottom = compact ? '0' : block.tagName === 'P' ? '1em' : '0.5em';
    }
    if (!block.style.lineHeight) {
      for (let parent = block.parentElement; parent; parent = parent.parentElement) {
        if (parent.style.lineHeight) { block.style.lineHeight = parent.style.lineHeight; break; }
      }
    }
  }
  // Carry inherited typography onto text spans before unsupported wrappers
  // (Docs divs and Word containers) are flattened by the editor schema.
  const texts: Text[] = [];
  const walk = document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) texts.push(walk.currentNode as Text);
  for (const text of texts) {
    if (!text.textContent?.trim() || text.parentElement?.closest('pre,code,script,style')) continue;
    const styles = new Map<string,string>();
    for (let parent = text.parentElement; parent; parent = parent.parentElement) {
      for (const key of INLINE_KEYS) if (!styles.has(key) && parent.style.getPropertyValue(key)) styles.set(key,parent.style.getPropertyValue(key));
    }
    if (styles.size) {
      const span = document.createElement('span');
      span.setAttribute('style',Array.from(styles,([key,value])=>`${key}:${value}`).join(';'));
      text.replaceWith(span); span.append(text);
    }
  }
  // Clipboard class names must not activate the host application's CSS.
  for (const el of root.querySelectorAll('[class]')) {
    const language = el.tagName === 'CODE' ? /(?:^|\s)(language-[\w-]+)/.exec(el.className)?.[1] : undefined;
    if (language) el.setAttribute('class',language); else el.removeAttribute('class');
  }
  return sanitizeEmailHtml(template.innerHTML);
}
export function markdownToComposeHtml(source: string): string {
  return normalizeComposeHtml(marked.parse(source,{async:false,gfm:true,breaks:false}));
}
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(?:#{1,6}\s+|```|~~~|>\s+)|\*\*[^\n]+\*\*|\[[^\]\n]+\]\(https?:[^\s)]+\)|(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/.test(text);
}
export const COMPOSE_FONTS = [
  ['Arial','Arial, Helvetica, sans-serif'],['Aptos / Calibri','Aptos, Calibri, Arial, sans-serif'],
  ['Georgia','Georgia, serif'],['Times New Roman','Times New Roman, Times, serif'],
  ['Verdana','Verdana, Geneva, sans-serif'],['Monospace','Consolas, Courier New, monospace'],
] as const;

/** Preserve literal text and blank lines without interpreting Markdown or HTML. */
export function plainTextToComposeHtml(source: string): string {
  const container = document.createElement('div');
  for (const line of source.split(/\r\n?|\n/)) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    if (!line) paragraph.append(document.createElement('br'));
    container.append(paragraph);
  }
  return container.innerHTML;
}
