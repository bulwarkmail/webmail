import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MailListRowsSkeleton, MailSkeleton } from '../mail-skeleton';

function html(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(element);
  return container;
}

describe('mail skeleton', () => {
  // The app hides its bottom bar while a message is open on a phone; the
  // skeleton of /mail/message/<id> must not draw one either.
  it('hides the phone bottom bar when a message or conversation is open', () => {
    const page = html(<MailSkeleton label="Loading" />);
    // The bar's items are its 64px-basis tabs; it is the last such row on the page.
    const tabs = page.querySelectorAll('.basis-\\[64px\\]');
    const bar = tabs[tabs.length - 1]?.parentElement as HTMLElement;
    expect(bar.querySelector('svg')).not.toBeNull();
    expect(bar).toBeTruthy();
    expect(bar.className.split(' ')).toContain('max-md:boot-open:hidden');
  });

  it('draws only the body inside a Pro pane: no frame, no sidebar header', () => {
    const pane = html(<MailSkeleton label="Loading" embedded />);
    const region = pane.querySelector('[data-boot-skeleton="mail"]')!;
    expect(region.className).toContain('h-full');
    expect(region.className).not.toContain('h-dvh');
    expect(pane.querySelector('.boot-out\\:block')).toBeNull();
    expect(pane.querySelector('.lg\\:mv\\:hidden.border-b')).toBeNull();
  });

  it.each([
    ['extra-compact', 0, 0],
    ['compact', 16, 0],
    ['regular', 16, 16],
  ] as const)('draws %s stacked rows with %i avatars and %i previews', (density, avatars, previews) => {
    const rows = html(<MailListRowsSkeleton shape="stacked" density={density} preview />);
    expect(rows.querySelectorAll('.w-10.h-10').length).toBe(avatars);
    expect(rows.querySelectorAll('.leading-relaxed').length).toBe(previews * 2);
  });

  it('leaves the preview out when previews are turned off', () => {
    const rows = html(<MailListRowsSkeleton shape="stacked" density="comfortable" preview={false} />);
    expect(rows.querySelectorAll('.leading-relaxed').length).toBe(0);
  });

  it('draws every shape for the boot page and lets the boot attributes pick', () => {
    const rows = html(<MailListRowsSkeleton />);
    expect(rows.querySelector('.boot-xc\\:hidden')).not.toBeNull();
    expect(rows.querySelector('.boot-dense\\:hidden')).not.toBeNull();
    expect(rows.querySelector('.md\\:mv\\:block')).not.toBeNull();
  });
});
