import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateAppLinkClick, isPlainLinkClick, openLinkInSidebarApp, sidebarAppForLink } from '@/lib/sidebar-app-links';
import type { AdminSidebarApp } from '@/lib/admin/types';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useSidebarAppFramesStore, type LiveAppFrame } from '@/stores/sidebar-app-frames-store';
import { useUIStore } from '@/stores/ui-store';
import { clearAllHooks, uiHooks } from '@/lib/plugin-hooks';

// A link in a mail to an admin inline app's origin (a chat app's permalink)
// opens that app in its pane, at that address. Nothing else changes.

function admin(overrides: Partial<AdminSidebarApp> = {}): AdminSidebarApp {
  return {
    id: 'default-chat',
    name: 'Chat',
    url: 'https://chat.example.com/',
    icon: 'Globe',
    openMode: 'inline',
    showOnMobile: false,
    ...overrides,
  };
}

const POST = 'https://chat.example.com/team/pl/abc123';

function policyApps(apps: AdminSidebarApp[]) {
  usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, defaultSidebarApps: apps } });
}

const click = (overrides: Partial<MouseEvent> = {}) =>
  ({ type: 'click', button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides }) as MouseEvent;

let defaults: unknown;
/** What each page that can show apps was asked to show, by its id. */
let shownIn: Record<number, LiveAppFrame>;
const addHost = (id: number) =>
  useSidebarAppFramesStore.getState().addHost({ id, show: (app) => { shownIn[id] = app; } });
const shown = () => Object.values(shownIn)[0] ?? null;

beforeEach(() => {
  defaults = usePolicyStore.getState().policy.defaultSidebarApps;
  useSettingsStore.setState({ sidebarApps: [], keepAppsLoaded: false });
  useSidebarAppFramesStore.setState({ frames: [], shown: null, badges: {}, hosts: [] });
  shownIn = {};
  useUIStore.setState({ isMobile: false });
});

afterEach(() => {
  usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, defaultSidebarApps: defaults as AdminSidebarApp[] } });
  vi.restoreAllMocks();
  clearAllHooks();
});

describe('sidebarAppForLink', () => {
  it("takes an inline app's link by its origin", () => {
    expect(sidebarAppForLink(POST, [admin()])?.id).toBe('default-chat');
  });

  it('leaves another origin, a tab app and other schemes', () => {
    expect(sidebarAppForLink('https://other.example.com/team/pl/abc', [admin()])).toBeNull();
    expect(sidebarAppForLink(POST, [admin({ openMode: 'tab' })])).toBeNull();
    expect(sidebarAppForLink('javascript:alert(1)', [admin()])).toBeNull();
    expect(sidebarAppForLink('not a url', [admin()])).toBeNull();
  });

  it('compares origins as parsed, never as a prefix', () => {
    expect(sidebarAppForLink('https://chat.example.com.evil.test/pl/x', [admin()])).toBeNull();
    expect(sidebarAppForLink('https://chat.example.com@evil.test/pl/x', [admin()])).toBeNull();
    expect(sidebarAppForLink('http://chat.example.com/pl/x', [admin()])).toBeNull();
    expect(sidebarAppForLink('https://chat.example.com:8443/pl/x', [admin()])).toBeNull();
    expect(sidebarAppForLink('HTTPS://CHAT.example.com/pl/x', [admin()])?.id).toBe('default-chat');
  });

  it('leaves a link with a user name or password', () => {
    expect(sidebarAppForLink('https://user@chat.example.com/pl/x', [admin()])).toBeNull();
    expect(sidebarAppForLink('https://user:pw@chat.example.com/pl/x', [admin()])).toBeNull();
    expect(sidebarAppForLink('https://:pw@chat.example.com/pl/x', [admin()])).toBeNull();
  });

  it('of two apps on one origin takes the longest path prefix, by whole segments', () => {
    const apps = [
      admin({ id: 'root', url: 'https://chat.example.com/' }),
      admin({ id: 'wiki', url: 'https://chat.example.com/wiki' }),
      admin({ id: 'wiki-team', url: 'https://chat.example.com/wiki/team/' }),
    ];
    expect(sidebarAppForLink('https://chat.example.com/wiki', apps)?.id).toBe('wiki');
    expect(sidebarAppForLink('https://chat.example.com/wiki/page', apps)?.id).toBe('wiki');
    expect(sidebarAppForLink('https://chat.example.com/wiki/team/x', apps)?.id).toBe('wiki-team');
    expect(sidebarAppForLink('https://chat.example.com/wikis/x', apps)?.id).toBe('root');
    expect(sidebarAppForLink('https://chat.example.com/team/pl/x', apps)?.id).toBe('root');
    // No app's path covers it: the first app of that origin.
    const noRoot = apps.slice(1);
    expect(sidebarAppForLink('https://chat.example.com/team/pl/x', noRoot)?.id).toBe('wiki');
  });
});

describe('isPlainLinkClick', () => {
  it('is the main button alone', () => {
    expect(isPlainLinkClick(click())).toBe(true);
    expect(isPlainLinkClick(click({ ctrlKey: true }))).toBe(false);
    expect(isPlainLinkClick(click({ metaKey: true }))).toBe(false);
    expect(isPlainLinkClick(click({ shiftKey: true }))).toBe(false);
    expect(isPlainLinkClick(click({ altKey: true }))).toBe(false);
    expect(isPlainLinkClick(click({ type: 'auxclick', button: 1 }))).toBe(false);
  });
});

describe('openLinkInSidebarApp', () => {
  it('opens the admin app at the link in the newest page that shows apps', () => {
    policyApps([admin()]);
    addHost(1);
    addHost(2);

    expect(openLinkInSidebarApp(POST)).toBe(true);
    expect(Object.keys(shownIn)).toEqual(['2']);
    expect(shownIn[2]).toMatchObject({ id: 'admin-app-default-chat', url: 'https://chat.example.com/', src: POST, name: 'Chat' });
    expect(useSidebarAppFramesStore.getState().frames.map((a) => a.src)).toEqual([POST]);
  });

  it("leaves a user's own app with that origin to the new tab", () => {
    useSettingsStore.setState({ sidebarApps: [{ ...admin({ id: 'mine' }) }] });
    policyApps([]);
    addHost(1);
    expect(openLinkInSidebarApp(POST)).toBe(false);
    expect(shown()).toBeNull();
  });

  it('leaves a tab app, another origin, and a document without a page for apps', () => {
    policyApps([admin({ openMode: 'tab' })]);
    addHost(1);
    expect(openLinkInSidebarApp(POST)).toBe(false);

    policyApps([admin()]);
    expect(openLinkInSidebarApp('https://other.example.com/x')).toBe(false);

    useSidebarAppFramesStore.getState().removeHost(1);
    expect(openLinkInSidebarApp(POST)).toBe(false);
    expect(shown()).toBeNull();
  });

  it('on a phone only an app shown on mobile', () => {
    policyApps([admin()]);
    useUIStore.setState({ isMobile: true });
    addHost(1);
    expect(openLinkInSidebarApp(POST)).toBe(false);

    policyApps([admin({ showOnMobile: true })]);
    expect(openLinkInSidebarApp(POST)).toBe(true);
  });
});

describe('gateAppLinkClick (a plain-text body)', () => {
  function linkEvent(href: string, overrides: Partial<MouseEvent> = {}) {
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.textContent = 'the post';
    document.body.append(a);
    return { ...click(overrides), target: a, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  }

  it("opens an admin app's link in the sidebar", async () => {
    policyApps([admin()]);
    addHost(1);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const event = linkEvent(POST);

    gateAppLinkClick(event);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(shown()?.src).toBe(POST));
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves a Ctrl+click and another origin to the browser, as before', () => {
    policyApps([admin()]);
    addHost(1);
    const ctrl = linkEvent(POST, { ctrlKey: true });
    gateAppLinkClick(ctrl);
    const other = linkEvent('https://other.example.com/x');
    gateAppLinkClick(other);
    // No link check listens: gateLinkClick leaves both to the browser.
    expect(ctrl.preventDefault).not.toHaveBeenCalled();
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(shown()).toBeNull();
  });

  it("decides on the link check's address, not the link's", async () => {
    policyApps([admin()]);
    addHost(1);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    uiHooks.onBeforeExternalLink.register('p1', (ctx: { href: string }) =>
      (ctx.href === POST ? { href: 'https://other.example.com/y' } : { href: POST }));

    const rewrittenOnto = linkEvent('https://other.example.com/x');
    gateAppLinkClick(rewrittenOnto);
    expect(rewrittenOnto.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(shown()?.src).toBe(POST));
    expect(open).not.toHaveBeenCalled();

    shownIn = {};
    gateAppLinkClick(linkEvent(POST));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://other.example.com/y', '_blank', 'noopener,noreferrer'));
    expect(shown()).toBeNull();
  });
});
