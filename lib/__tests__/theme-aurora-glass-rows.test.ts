import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from '../builtin-themes';

// Under Aurora Glass the read rows carried the glass mesh and looked brighter
// than the unread ones. The skin swaps them: unread rows get the mesh, read
// rows the accent tint. Rows the skin must leave alone: a tinted row (tag or
// account colour), a selected one, a hovered one, and every row under another
// theme.

const aurora = BUILTIN_THEMES.find((theme) => theme.id === 'builtin-aurora-glass')!;

function mountRow({ unread, className, skin = 'builtin-aurora-glass', attrs = '' }: {
  unread: boolean;
  className: string;
  skin?: string;
  attrs?: string;
}) {
  document.body.setAttribute('data-theme-skin', skin);
  const style = document.createElement('style');
  style.textContent = aurora.skin!;
  document.head.appendChild(style);
  document.body.innerHTML = `<div id="row" data-menu-row="" data-unread="${unread}" class="${className}" ${attrs}></div>`;
  const computed = getComputedStyle(document.getElementById('row')!);
  return { image: computed.backgroundImage, color: computed.backgroundColor };
}

const ROW = 'relative group cursor-pointer overflow-hidden';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.removeAttribute('data-theme-skin');
});

describe('Aurora Glass message-list rows', () => {
  it('gives an unread row the glass mesh', () => {
    expect(mountRow({ unread: true, className: `${ROW} bg-accent/30` }).image).toContain('radial-gradient');
  });

  it('gives a read row the accent tint instead of the mesh', () => {
    const read = mountRow({ unread: false, className: `${ROW} bg-background` });
    expect(read.image).not.toContain('radial-gradient');
    expect(read.color).toContain('color-mix');
  });

  it('leaves a selected unread row its selection colour', () => {
    expect(mountRow({ unread: true, className: `${ROW} bg-accent/30 shadow-sm`, attrs: 'aria-current="true"' }).image)
      .not.toContain('radial-gradient');
  });

  it('leaves tinted rows alone', () => {
    expect(mountRow({ unread: true, className: `${ROW} bg-red-50` }).image).not.toContain('radial-gradient');
    expect(mountRow({ unread: false, className: `${ROW} bg-red-50` }).color).not.toContain('color-mix');
  });

  it('does nothing under another theme', () => {
    expect(mountRow({ unread: true, className: `${ROW} bg-accent/30`, skin: 'builtin-elastic' }).image).not.toContain('radial-gradient');
    expect(mountRow({ unread: false, className: `${ROW} bg-background`, skin: 'builtin-elastic' }).color).not.toContain('color-mix');
  });
});
