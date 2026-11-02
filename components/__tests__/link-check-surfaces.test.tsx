// Links outside message bodies opened without the plugins' link check
// (onBeforeExternalLink): the reader view, event descriptions, locations
// and meeting links, contact addresses, notification links, the
// List-Unsubscribe page, a middle-click, and other plugins'
// ui.openExternalUrl. A link check that warned in the reader was no check.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearAllHooks, pluginErrorTracker, uiHooks } from '@/lib/plugin-hooks';
import { gateLinkClick, linkText, openExternalLink, resolveExternalLink } from '@/lib/plugin-hook-result';
import { LinkifiedText } from '@/components/ui/linkified-text';
import { ReaderViewDialog } from '@/components/email/reader-view-dialog';
import type { ExternalLinkContext } from '@/lib/plugin-types';

vi.mock('@/hooks/use-focus-trap', () => ({ useFocusTrap: () => ({ current: null }) }));

afterEach(() => {
  cleanup();
  clearAllHooks();
  pluginErrorTracker.resetAll();
  vi.restoreAllMocks();
});

function watchLinks(answer: (ctx: ExternalLinkContext) => unknown = () => undefined) {
  const seen: ExternalLinkContext[] = [];
  uiHooks.onBeforeExternalLink.register('link-check', (ctx: ExternalLinkContext) => { seen.push(ctx); return answer(ctx); });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  return { seen, open };
}

describe('gateLinkClick', () => {
  it('sends a click on a web link through the check with the link text, then opens it', async () => {
    const { seen, open } = watchLinks();
    render(<div onClick={gateLinkClick}><a href="https://evil.example/x">https://bank.example</a></div>);
    expect(fireEvent.click(screen.getByRole('link'))).toBe(false);
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://evil.example/x', '_blank', 'noopener,noreferrer'));
    expect(seen).toEqual([{ href: 'https://evil.example/x', target: '_blank', text: 'https://bank.example' }]);
  });

  it('opens nothing when the check says no', async () => {
    const { seen, open } = watchLinks(() => false);
    render(<div onClick={gateLinkClick}><a href="https://evil.example/x">x</a></div>);
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() => expect(seen).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(open).not.toHaveBeenCalled();
  });

  it('gates a middle-click, and leaves right-clicks, mailto: and tel: to the browser', async () => {
    const { seen } = watchLinks(() => false);
    render(
      <div onClick={gateLinkClick} onAuxClick={gateLinkClick}>
        <a href="https://evil.example/m">m</a>
        <a href="mailto:a@example.org">mail</a>
        <a href="tel:+491">call</a>
      </div>,
    );
    const [web, mail, tel] = screen.getAllByRole('link');
    expect(fireEvent(web, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    expect(fireEvent(web, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))).toBe(true);
    expect(fireEvent.click(mail)).toBe(true);
    expect(fireEvent.click(tel)).toBe(true);
    await waitFor(() => expect(seen.map((c) => c.href)).toEqual(['https://evil.example/m']));
  });

  it('names an image link by its alt text', () => {
    const a = document.createElement('a');
    a.innerHTML = '<img alt="  Sign in to   PayPal ">';
    expect(linkText(a)).toBe('Sign in to PayPal');
    a.textContent = 'x'.repeat(300);
    expect(linkText(a)).toHaveLength(200);
  });
});

describe('resolveExternalLink and openExternalLink', () => {
  it("doesn't ask the plugin that opens the link itself", async () => {
    const own = vi.fn(() => false);
    const other = vi.fn(() => undefined);
    uiHooks.onBeforeExternalLink.register('link-check', own);
    uiHooks.onBeforeExternalLink.register('other', other);
    expect(await resolveExternalLink({ href: 'https://a.example/' }, { skipPluginId: 'link-check' })).toBe('https://a.example/');
    expect(own).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
    expect(await resolveExternalLink({ href: 'https://a.example/' })).toBeNull();
  });

  it('opens only web addresses', async () => {
    const { open } = watchLinks();
    expect(await openExternalLink({ href: 'javascript:alert(1)' })).toBe(false);
    expect(await openExternalLink({ href: 'https://a.example/' })).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('surfaces', () => {
  it('event descriptions (LinkifiedText)', async () => {
    const { seen, open } = watchLinks(() => false);
    render(<LinkifiedText text="Join: https://meet.example/abc" />);
    expect(fireEvent.click(screen.getByRole('link'))).toBe(false);
    await waitFor(() => expect(seen.map((c) => c.href)).toEqual(['https://meet.example/abc']));
    expect(open).not.toHaveBeenCalled();
  });

  it('the reader view', async () => {
    const { seen } = watchLinks(() => false);
    render(
      <ReaderViewDialog isOpen onClose={() => {}} title="t" html={'<a href="https://evil.example/r" target="_blank">click</a>'} />,
    );
    const link = screen.getByTestId('reader-view-body').querySelector('a')!;
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(seen).toEqual([expect.objectContaining({ href: 'https://evil.example/r', text: 'click' })]));
  });
});

describe("other plugins' ui.openExternalUrl", () => {
  it('goes through the link check, except for the plugin asking', async () => {
    const { dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
    const { seen, open } = watchLinks(() => false);
    const caller = (id: string) => ({
      id, name: id, version: '1', author: '', description: '', type: 'hook', permissions: [], entrypoint: 'index.js',
      enabled: true, status: 'running', settings: {},
    }) as never;
    await dispatchApiCall(caller('other'), 'ui.openExternalUrl', ['https://evil.example/p']);
    expect(seen.map((c) => c.href)).toEqual(['https://evil.example/p']);
    expect(open).not.toHaveBeenCalled();
    // The link check opening the link after its own dialog.
    await dispatchApiCall(caller('link-check'), 'ui.openExternalUrl', ['https://evil.example/p']);
    expect(seen).toHaveLength(1);
    expect(open).toHaveBeenCalledWith('https://evil.example/p', '_blank', 'noopener,noreferrer');
  });
});

// What is checked is what opens: the host hands plugins the address as the
// browser parses it, and opens exactly that.
describe('one address end to end', () => {
  it('checks and opens the address the browser really goes to', async () => {
    const { seen, open } = watchLinks();
    render(<div onClick={gateLinkClick}><a href={'http://evil.example\\@good.example/login'}>login</a></div>);
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://evil.example/@good.example/login', '_blank', 'noopener,noreferrer'));
    expect(seen[0].href).toBe('http://evil.example/@good.example/login');
  });

  it('hands over international names in their punycode form', async () => {
    const { seen } = watchLinks(() => false);
    expect(await resolveExternalLink({ href: 'https://b\u00fccher.example/a' })).toBeNull();
    expect(seen[0].href).toBe('https://xn--bcher-kva.example/a');
  });
});

// Without a link check listening, clicks stay exactly as they were.
describe('no link check listening', () => {
  it('leaves clicks and middle-clicks to the browser', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<div onClick={gateLinkClick} onAuxClick={gateLinkClick}><a href="https://a.example/">a</a></div>);
    expect(fireEvent.click(screen.getByRole('link'))).toBe(true);
    expect(fireEvent(screen.getByRole('link'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens at once, inside the click, from code that opens a link itself', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    void openExternalLink({ href: 'https://a.example/' });
    expect(open).toHaveBeenCalledWith('https://a.example/', '_blank', 'noopener,noreferrer');
  });

  it("opens a plugin's own link at once when only that plugin listens", async () => {
    const { dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
    uiHooks.onBeforeExternalLink.register('link-check', () => false);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const call = dispatchApiCall({ id: 'link-check', name: 'x', version: '1', author: '', description: '', type: 'hook', permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {} } as never, 'ui.openExternalUrl', ['https://a.example/']);
    expect(open).toHaveBeenCalledTimes(1);
    await call;
  });
});
