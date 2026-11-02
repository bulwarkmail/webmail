import type { KeyboardEvent } from 'react';

/** Navigate the rail without activating routes or bypassing leave guards. */
export function navigateRail(event: KeyboardEvent<HTMLElement>, horizontal = false) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest('input,textarea,select,[contenteditable="true"]')) return;
  const root = event.currentTarget;
  const items = Array.from(root.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)')).filter(item => {
    if (item.getAttribute('aria-disabled') === 'true') return false;
    for (let node: HTMLElement | null = item; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
  const index = items.findIndex(item => item === target || item.contains(target));
  if (index < 0) return;
  const rtl = getComputedStyle(root).direction === 'rtl';
  const forward = horizontal ? (rtl ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
  const backward = horizontal ? (rtl ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';
  let next: number;
  if (event.key === forward) next = (index + 1) % items.length;
  else if (event.key === backward) next = (index - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else return;
  event.preventDefault();
  event.stopPropagation();
  items[next].focus();
  items[next].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
