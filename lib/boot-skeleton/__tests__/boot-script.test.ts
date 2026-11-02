import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootConfig, bootSkeletonScript, type BootLayoutConfig } from '../boot-script';
import { THEME_CACHE_KEY } from '../keys';

/**
 * Runs the exact string the root layout inlines into <head>, in a scope with
 * none of this module's imports: a function that reached for one would throw
 * here (and in the browser), and the test would see default attributes.
 */
function boot(path: string, config: Partial<BootLayoutConfig> = {}) {
  window.history.replaceState(null, '', path);
  new Function(bootSkeletonScript({ ...bootConfig(), ...config }))();
}

const html = () => document.documentElement;
const attr = (name: string) => html().getAttribute(`data-boot-${name}`);
const cssVar = (name: string) => html().style.getPropertyValue(name);
const settings = (state: Record<string, unknown>) =>
  localStorage.setItem('settings-storage', JSON.stringify({ state, version: 12 }));
const signedIn = () =>
  localStorage.setItem('auth-storage', JSON.stringify({ state: { isAuthenticated: true }, version: 0 }));

function desktop(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches && query.includes('64rem'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const a of [...html().attributes]) {
    if (a.name.startsWith('data-boot-') || a.name === 'data-interface-layout' || a.name === 'data-theme-skin' || a.name === 'style') {
      html().removeAttribute(a.name);
    }
  }
  document.head.querySelectorAll('#active-theme, #active-theme-skin').forEach((el) => el.remove());
  desktop(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('boot script: defaults', () => {
  it('draws the split inbox with the regular density and default widths when nothing is stored', () => {
    boot('/en/mail/folder/inbox');
    expect(attr('surface')).toBe('mail');
    expect(attr('mail-layout')).toBe('split');
    expect(html().getAttribute('data-interface-layout')).toBe('default');
    expect(cssVar('--list-item-height')).toBe('48px');
    expect(cssVar('--density-item-py')).toBe('12px');
    expect(cssVar('--boot-mail-sidebar-w')).toBe('256px');
    expect(cssVar('--boot-mail-list-w')).toBe('384px');
    expect(cssVar('--boot-mail-list-h')).toBe('320px');
    expect(attr('pane')).toBeNull();
    expect(attr('pro')).toBeNull();
  });

  it('treats the bare root as mail', () => {
    boot('/');
    expect(attr('surface')).toBe('mail');
  });

  it('survives corrupt JSON in every key it reads', () => {
    for (const key of ['settings-storage', 'column-widths', 'calendar-storage', 'auth-storage', 'account-registry', 'bulwark-boot-hints', THEME_CACHE_KEY]) {
      localStorage.setItem(key, '{not json');
    }
    boot('/en/calendar');
    expect(attr('surface')).toBe('calendar');
    expect(attr('calendar-view')).toBe('month');
    expect(cssVar('--list-item-height')).toBe('48px');
    expect(cssVar('--boot-mail-sidebar-w')).toBe('256px');
    expect(attr('rail')).toBeNull();
    expect(document.getElementById('active-theme')).toBeNull();
  });

  it('survives storage that throws on access', () => {
    const throwing = { get: () => { throw new Error('SecurityError'); } };
    const local = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const session = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, ...throwing });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, ...throwing });
    try {
      boot('/en/settings/filters');
      expect(attr('surface')).toBe('settings');
      expect(attr('settings-tab')).toBe('filters');
      expect(cssVar('--boot-settings-nav-w')).toBe('256px');
    } finally {
      Object.defineProperty(window, 'localStorage', local!);
      Object.defineProperty(window, 'sessionStorage', session!);
    }
  });

  it('ignores state that is not an object', () => {
    localStorage.setItem('settings-storage', JSON.stringify({ state: 'oops' }));
    localStorage.setItem('column-widths', JSON.stringify([1, 2]));
    boot('/en/mail');
    expect(attr('mail-layout')).toBe('split');
    expect(cssVar('--boot-mail-list-w')).toBe('384px');
  });
});

describe('boot script: layout settings', () => {
  it('applies Mountain View, its density rhythm and forces the focus layout', () => {
    settings({ interfaceLayout: 'mountain-view', density: 'compact', mailLayout: 'split' });
    boot('/en/mail');
    expect(html().getAttribute('data-interface-layout')).toBe('mountain-view');
    expect(cssVar('--list-item-height')).toBe('32px');
    expect(cssVar('--density-item-py')).toBe('6px');
    expect(cssVar('--density-item-gap')).toBe('8px');
    expect(attr('mail-layout')).toBe('focus');
  });

  it.each([
    ['extra-compact', 'auto', '2px', '0px'],
    ['compact', 'auto', '4px', '1px'],
    ['regular', '48px', '12px', '4px'],
    ['comfortable', '64px', '16px', '6px'],
  ])('writes the %s density variables', (density, height, py, sidebar) => {
    settings({ density });
    boot('/en/mail');
    expect(cssVar('--list-item-height')).toBe(height);
    expect(cssVar('--density-item-py')).toBe(py);
    expect(cssVar('--density-sidebar-py')).toBe(sidebar);
    expect(attr('density')).toBe(density);
  });

  it('falls back to regular for an unknown density', () => {
    settings({ density: 'cosy' });
    boot('/en/mail');
    expect(cssVar('--list-item-height')).toBe('48px');
    expect(attr('density')).toBe('regular');
  });

  it('keeps the horizontal and focus layouts, and simple mode forces focus', () => {
    settings({ mailLayout: 'horizontal' });
    boot('/en/mail');
    expect(attr('mail-layout')).toBe('horizontal');
    settings({ mailLayout: 'focus' });
    boot('/en/mail');
    expect(attr('mail-layout')).toBe('focus');
    settings({ mailLayout: 'horizontal', simpleMode: true });
    boot('/en/mail');
    expect(attr('mail-layout')).toBe('focus');
  });

  it('clamps stored column widths the way the mail store does', () => {
    localStorage.setItem('column-widths', JSON.stringify({ sidebarWidth: 1000, emailListWidth: 100, emailListHeight: 500 }));
    boot('/en/mail');
    expect(cssVar('--boot-mail-sidebar-w')).toBe('400px');
    expect(cssVar('--boot-mail-list-w')).toBe('240px');
    expect(cssVar('--boot-mail-list-h')).toBe('500px');
  });

  it('reads the other surfaces\' widths, defaulting bad values', () => {
    localStorage.setItem('calendar-sidebar-width', '300');
    localStorage.setItem('contacts-sidebar-width', 'abc');
    localStorage.setItem('contacts-list-width', '450');
    localStorage.setItem('files-sidebar-width', '999');
    localStorage.setItem('settings-sidebar-width', '210');
    boot('/en/contacts');
    expect(cssVar('--boot-cal-sidebar-w')).toBe('300px');
    expect(cssVar('--boot-contacts-sidebar-w')).toBe('256px');
    expect(cssVar('--boot-contacts-list-w')).toBe('450px');
    expect(cssVar('--boot-files-sidebar-w')).toBe('400px');
    expect(cssVar('--boot-settings-nav-w')).toBe('210px');
  });

  it('marks the files view and details panel', () => {
    settings({ filesSettings: { defaultViewMode: 'grid' } });
    localStorage.setItem('files-show-details', '1');
    boot('/en/files/Documents');
    expect(attr('surface')).toBe('files');
    expect(attr('files-view')).toBe('grid');
    expect(attr('files-details')).toBe('on');
  });
});

describe('boot script: mail and contacts panes', () => {
  it.each([
    ['/en/mail/message/M123', 'message'],
    ['/en/mail/thread/T9', 'thread'],
    ['/en/mail?email=M1', 'message'],
    ['/en/mail/folder/inbox', null],
    ['/en/mail/message', null],
  ])('%s opens pane %s', (path, pane) => {
    boot(path);
    expect(attr('pane')).toBe(pane);
  });

  it.each([
    ['/en/contacts', null],
    ['/en/contacts/new', 'create'],
    ['/en/contacts?addEmail=a%40example.com', 'create'],
    ['/en/contacts/abc/edit', 'detail'],
    ['/en/contacts?contactId=abc', 'detail'],
  ])('%s opens pane %s', (path, pane) => {
    boot(path);
    expect(attr('surface')).toBe('contacts');
    expect(attr('pane')).toBe(pane);
  });
});

describe('boot script: calendar', () => {
  it.each(['month', 'week', 'day', 'agenda', 'tasks'])('takes the %s view from the URL', (view) => {
    localStorage.setItem('calendar-storage', JSON.stringify({ state: { viewMode: 'agenda' } }));
    boot(`/en/calendar/${view}/2026-11-04`);
    expect(attr('calendar-view')).toBe(view);
  });

  it('opens a bare date in month view, like parseCalendarPath', () => {
    localStorage.setItem('calendar-storage', JSON.stringify({ state: { viewMode: 'week' } }));
    boot('/en/calendar/2026-11-04');
    expect(attr('calendar-view')).toBe('month');
  });

  it('uses the stored view for /calendar and event links, month without one', () => {
    localStorage.setItem('calendar-storage', JSON.stringify({ state: { viewMode: 'day' } }));
    boot('/en/calendar');
    expect(attr('calendar-view')).toBe('day');
    boot('/en/calendar/event/E1');
    expect(attr('calendar-view')).toBe('day');
    localStorage.setItem('calendar-storage', JSON.stringify({ state: { viewMode: 'year' } }));
    boot('/en/calendar');
    expect(attr('calendar-view')).toBe('month');
  });

  it('counts week columns and display hours from the settings', () => {
    boot('/en/calendar/week');
    expect(cssVar('--boot-cal-cols')).toBe('7');
    expect(cssVar('--boot-cal-hours')).toBe('12');
    settings({ calendarHideNonWorkingDays: true, calendarWorkingDays: [1, 2, 3, 4, 5], calendarDayStartHour: 7, calendarDayEndHour: 19 });
    boot('/en/calendar/week');
    expect(cssVar('--boot-cal-cols')).toBe('5');
    expect(cssVar('--boot-cal-hours')).toBe('12');
    settings({ calendarLimitHours: false, calendarHideNonWorkingDays: true, calendarWorkingDays: [] });
    boot('/en/calendar/week');
    expect(cssVar('--boot-cal-cols')).toBe('7');
    expect(cssVar('--boot-cal-hours')).toBe('24');
    settings({ calendarDayStartHour: 20, calendarDayEndHour: 8 });
    boot('/en/calendar/week');
    expect(cssVar('--boot-cal-hours')).toBe('24');
  });

  it('marks a collapsed calendar sidebar', () => {
    localStorage.setItem('calendar-sidebar-collapsed', '1');
    boot('/en/calendar');
    expect(attr('collapsed')).toBe('calendar');
  });

  it('gives the first shown hour, 0 for the whole day', () => {
    boot('/en/calendar/week');
    expect(cssVar('--boot-cal-start')).toBe('8');
    settings({ calendarDayStartHour: 6, calendarDayEndHour: 22 });
    boot('/en/calendar/week');
    expect(cssVar('--boot-cal-start')).toBe('6');
    settings({ calendarLimitHours: false, calendarDayStartHour: 6, calendarDayEndHour: 22 });
    boot('/en/calendar/week');
    expect(cssVar('--boot-cal-start')).toBe('0');
  });

  describe('with a fixed clock', () => {
    afterEach(() => vi.useRealTimers());

    it('opens the hour grid an hour before now, at the top when now is outside the shown hours', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 10, 4, 15, 30));
      boot('/en/calendar/week');
      expect(cssVar('--boot-cal-scroll')).toBe('6');
      settings({ calendarLimitHours: false });
      boot('/en/calendar/day');
      expect(cssVar('--boot-cal-scroll')).toBe('14');
      vi.setSystemTime(new Date(2026, 10, 4, 21, 0));
      settings({});
      boot('/en/calendar/week');
      expect(cssVar('--boot-cal-scroll')).toBe('-1');
    });

    it('reads the clock in the time zone the settings name', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 4, 14, 0)));
      settings({ calendarLimitHours: false, timeZone: 'Asia/Tokyo' });
      boot('/en/calendar/week');
      // 23:00 in Tokyo.
      expect(cssVar('--boot-cal-scroll')).toBe('22');
      settings({ calendarLimitHours: false, timeZone: 'Not/AZone' });
      boot('/en/calendar/week');
      expect(cssVar('--boot-cal-scroll')).toBe(String(new Date().getHours() - 1));
    });

    it('counts the mini month rows of the linked month, else this one', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 1, 10, 12, 0));
      // February 2026 starts on a Sunday and has 28 days.
      boot('/en/calendar');
      expect(cssVar('--boot-cal-mini-rows')).toBe('5');
      settings({ firstDayOfWeek: 0 });
      boot('/en/calendar');
      expect(cssVar('--boot-cal-mini-rows')).toBe('4');
      // November 2026 starts on a Sunday: six rows from Monday, five from Sunday.
      settings({});
      boot('/en/calendar/week/2026-11-04');
      expect(cssVar('--boot-cal-mini-rows')).toBe('6');
      boot('/en/calendar/2026-11-04');
      expect(cssVar('--boot-cal-mini-rows')).toBe('6');
      settings({ firstDayOfWeek: 0 });
      boot('/en/calendar/week/2026-11-04');
      expect(cssVar('--boot-cal-mini-rows')).toBe('5');
    });
  });

  it('marks week numbers in the mini month', () => {
    boot('/en/calendar');
    expect(attr('cal-weeknums')).toBeNull();
    settings({ showWeekNumbers: true });
    boot('/en/calendar');
    expect(attr('cal-weeknums')).toBe('on');
    boot('/en/mail');
    expect(attr('cal-weeknums')).toBeNull();
  });

  it('marks calendar tasks as on', () => {
    boot('/en/calendar');
    expect(attr('cal-tasks')).toBeNull();
    settings({ enableCalendarTasks: true });
    boot('/en/calendar');
    expect(attr('cal-tasks')).toBe('on');
    boot('/en/contacts');
    expect(attr('cal-tasks')).toBeNull();
  });
});

describe('boot script: settings', () => {
  it('opens the page a URL names, migrating legacy ids', () => {
    boot('/en/settings/themes');
    expect(attr('settings-tab')).toBe('appearance');
    expect(attr('pane')).toBe('detail');
    boot('/en/settings/filters/rules');
    expect(attr('settings-tab')).toBe('filters');
  });

  it('falls back to the stored tab for an unknown or missing URL tab', () => {
    localStorage.setItem('settings-active-tab', 'keywords');
    boot('/en/settings/no-such-tab');
    expect(attr('settings-tab')).toBe('organize');
    expect(attr('pane')).toBeNull();
    boot('/en/settings');
    expect(attr('settings-tab')).toBe('organize');
  });

  it('defaults to appearance, and honours the one-shot sidebar gear link', () => {
    boot('/en/settings');
    expect(attr('settings-tab')).toBe('appearance');
    sessionStorage.setItem('settings-deep-link-tab', 'folders');
    boot('/en/settings');
    expect(attr('settings-tab')).toBe('organize');
    expect(attr('pane')).toBe('detail');
  });
});

describe('boot script: pages that lead elsewhere', () => {
  it.each([
    ['/connector/app', 'mail', null],
    ['/connector/mail_folder?ref=inbox', 'mail', null],
    ['/connector/contacts', 'contacts', null],
    ['/connector/files?path=/Docs', 'files', null],
    ['/connector/setup', 'setup', null],
    ['/connector/admin?tab=logs', 'admin', 'detail'],
    ['/connector/admin', 'admin', null],
    ['/connector/admin_plugin?id=x', 'admin', 'detail'],
  ])('%s draws %s', (path, surface, pane) => {
    boot(path);
    expect(attr('surface')).toBe(surface);
    expect(attr('via')).toBe('connector');
    expect(attr('pane')).toBe(pane);
  });

  it('draws a connector calendar link in its view and a settings link on its page', () => {
    boot('/connector/calendar?view=agenda&date=2026-11-04');
    expect(attr('surface')).toBe('calendar');
    expect(attr('calendar-view')).toBe('agenda');
    boot('/connector/calendar');
    expect(attr('calendar-view')).toBe('month');
    boot('/connector/settings?tab=templates');
    expect(attr('surface')).toBe('settings');
    expect(attr('settings-tab')).toBe('composing');
  });

  it('leaves an unknown connector target without a surface', () => {
    boot('/connector/nope');
    expect(attr('surface')).toBeNull();
  });

  it('draws mail behind mailto and the calendar behind webcal', () => {
    boot('/protocol/mailto?url=mailto%3Aa%40b.c');
    expect(attr('surface')).toBe('mail');
    expect(attr('via')).toBe('mailto');
    boot('/protocol/webcal?url=webcal%3A%2F%2Fx');
    expect(attr('surface')).toBe('calendar');
    expect(attr('via')).toBe('webcal');
  });

  it.each([
    ['/admin', 'admin', null],
    ['/admin/branding', 'admin', 'detail'],
    ['/admin/login', 'admin-login', null],
    ['/setup', 'setup', null],
    ['/en/login', 'login', null],
    ['/en/pro', 'pro', null],
    ['/en/apps/plugin-x/page-y', 'apps', null],
  ])('%s is %s', (path, surface, pane) => {
    boot(path);
    expect(attr('surface')).toBe(surface);
    expect(attr('pane')).toBe(pane);
  });
});

describe('boot script: Pro interface', () => {
  it('predicts the hop to /pro on a desktop with the Pro interface on', () => {
    settings({ proInterface: true });
    boot('/en/mail/folder/inbox');
    expect(attr('pro')).toBe('on');
    boot('/en/settings/appearance');
    expect(attr('pro')).toBe('on');
    boot('/en/pro');
    expect(attr('pro')).toBe('on');
  });

  it('not on a narrow screen, not without the setting, not for other pages', () => {
    settings({ proInterface: true });
    desktop(false);
    boot('/en/mail');
    expect(attr('pro')).toBeNull();
    desktop(true);
    boot('/admin');
    expect(attr('pro')).toBeNull();
    settings({ proInterface: false });
    boot('/en/mail');
    expect(attr('pro')).toBeNull();
  });
});

describe('boot script: Pro tabs', () => {
  const tab = (id: string, kind: string, paneId = 'main') => ({ id, kind, labelKey: kind, closeable: id !== 'home-mail', paneId });
  const proTabs = (state: Record<string, unknown>) =>
    localStorage.setItem('pro-tabs', JSON.stringify({ state, version: 4 }));
  const pro = () => ({
    split: attr('pro-split'),
    focus: attr('pro-focus'),
    kind: attr('pro-kind'),
    main: [attr('pro-main-tabs'), attr('pro-main-active'), attr('pro-main-kind')],
    side: [attr('pro-split-tabs'), attr('pro-split-active'), attr('pro-split-kind')],
  });

  beforeEach(() => settings({ proInterface: true }));

  it('draws the single home mail tab when nothing is stored', () => {
    boot('/en/pro');
    expect(pro()).toEqual({ split: null, focus: 'main', kind: 'mail', main: ['1', '0', 'mail'], side: [null, null, null] });
  });

  it('falls back to the home mail tab for corrupt or empty tabs', () => {
    localStorage.setItem('pro-tabs', '{not json');
    boot('/en/pro');
    expect(pro().main).toEqual(['1', '0', 'mail']);
    proTabs({ tabs: 'nope', activeTabId: 3 });
    boot('/en/pro');
    expect(pro().main).toEqual(['1', '0', 'mail']);
    proTabs({ tabs: [null, { id: 'x' }, 7], activeTabId: 'x' });
    boot('/en/pro');
    expect(pro().main).toEqual(['1', '0', 'mail']);
  });

  it('reads the tab count, the active tab and the split', () => {
    proTabs({
      tabs: [tab('home-mail', 'mail'), tab('c', 'calendar'), tab('f', 'folder'), tab('s', 'settings', 'split'), tab('e', 'email', 'split')],
      activeTabId: 'c',
      activeSplitTabId: 'e',
      focusedPaneId: 'split',
      splitSide: 'left',
    });
    boot('/en/pro');
    expect(pro()).toEqual({
      split: 'left', focus: 'split', kind: 'email',
      main: ['3', '1', 'calendar'],
      side: ['2', '1', 'other'],
    });
  });

  it('gives the calendar and settings variants to a pane that shows them', () => {
    proTabs({ tabs: [tab('home-mail', 'mail'), tab('c', 'calendar'), tab('s', 'settings', 'split')], activeTabId: 'c', activeSplitTabId: 's' });
    localStorage.setItem('calendar-storage', JSON.stringify({ state: { viewMode: 'week' }, version: 0 }));
    localStorage.setItem('settings-active-tab', 'filters');
    boot('/en/pro');
    expect(attr('calendar-view')).toBe('week');
    expect(cssVar('--boot-cal-cols')).toBe('7');
    expect(attr('settings-tab')).toBe('filters');
    expect(attr('pane')).toBeNull();
  });

  it('merges a split pane into an empty main pane', () => {
    proTabs({ tabs: [tab('c', 'calendar', 'split'), tab('f', 'files', 'split')], activeTabId: 'gone', activeSplitTabId: 'f', focusedPaneId: 'split' });
    boot('/en/pro');
    expect(pro()).toEqual({ split: null, focus: 'main', kind: 'files', main: ['2', '1', 'files'], side: [null, null, null] });
  });

  it('focuses the tab the redirect opens for a standard page', () => {
    proTabs({
      tabs: [tab('home-mail', 'mail'), tab('c', 'calendar', 'split')],
      activeTabId: 'home-mail',
      activeSplitTabId: 'c',
      focusedPaneId: 'main',
    });
    boot('/en/calendar/week/2026-11-04');
    expect(pro()).toMatchObject({ split: 'right', focus: 'split', kind: 'calendar', main: ['1', '0', 'mail'], side: ['1', '0', 'calendar'] });
    expect(attr('calendar-view')).toBe('week');

    // No contacts tab yet: a new one at the end of the focused pane.
    boot('/en/contacts');
    expect(pro()).toMatchObject({ focus: 'main', kind: 'contacts', main: ['2', '1', 'contacts'], side: ['1', '0', 'calendar'] });
  });

  it('caps the drawn tabs at eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => tab(`t${i}`, i === 11 ? 'files' : 'email'));
    proTabs({ tabs: many, activeTabId: 't11' });
    boot('/en/pro');
    expect(pro().main).toEqual(['8', '7', 'files']);
  });

  it('sets nothing when Pro does not take the page over', () => {
    proTabs({ tabs: [tab('home-mail', 'mail'), tab('c', 'calendar', 'split')], activeSplitTabId: 'c' });
    desktop(false);
    boot('/en/mail');
    expect(pro()).toEqual({ split: null, focus: null, kind: null, main: [null, null, null], side: [null, null, null] });
    expect(attr('calendar-view')).toBeNull();
  });
});

describe('boot script: signed-out visitors', () => {
  it('marks a visitor with nothing stored as signed out on app pages', () => {
    boot('/en/mail');
    expect(attr('auth')).toBe('out');
    boot('/en/calendar/week');
    expect(attr('auth')).toBe('out');
  });

  it('not on the login, admin or setup pages', () => {
    for (const path of ['/en/login', '/admin', '/admin/login', '/setup']) {
      boot(path);
      expect(attr('auth')).toBeNull();
    }
  });

  it('not with a persisted session, a remembered account, a demo account or an impersonation hand-off', () => {
    signedIn();
    boot('/en/mail');
    expect(attr('auth')).toBeNull();
    localStorage.clear();
    localStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: 'a', rememberMe: true }] } }));
    boot('/en/mail');
    expect(attr('auth')).toBeNull();
    localStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: 'd', rememberMe: false, serverUrl: 'https://demo.example.com' }] } }));
    boot('/en/mail');
    expect(attr('auth')).toBeNull();
    localStorage.clear();
    boot('/en/mail?impersonated=1');
    expect(attr('auth')).toBeNull();
  });

  it('counts an account that will be dropped (no remember me) as signed out', () => {
    localStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: 'a', rememberMe: false }] } }));
    boot('/en/mail');
    expect(attr('auth')).toBe('out');
    boot('/en/mail', { lite: true });
    expect(attr('auth')).toBeNull();
  });
});

describe('boot script: rail hints', () => {
  it('passes the stored rail items on, dropping anything odd', () => {
    localStorage.setItem('bulwark-boot-hints', JSON.stringify({ v: 1, rail: ['mail', 'calendar', 'quota', '<x>', 3] }));
    boot('/en/mail');
    expect(attr('rail')).toBe('mail calendar quota');
  });

  it('passes the settings pages the nav listed on, known ids only', () => {
    localStorage.setItem('bulwark-boot-hints', JSON.stringify({ v: 1, rail: ['mail'], settings: ['account', 'filters', 'recovery', 'plugin:x', 'nope', 7] }));
    boot('/en/settings');
    expect(attr('settings-tabs')).toBe('account filters recovery');
  });

  it('leaves the settings pages out without hints', () => {
    boot('/en/settings');
    expect(attr('settings-tabs')).toBeNull();
  });
});

describe('boot script: Lite', () => {
  it('reads a parked deep link instead of the surface root it was replayed on', () => {
    sessionStorage.setItem('bulwark-lite:pending-path', '/de/calendar/day/2026-11-04');
    boot('/de/calendar/', { lite: true });
    expect(attr('surface')).toBe('calendar');
    expect(attr('calendar-view')).toBe('day');
  });

  it('ignores the parked path outside Lite', () => {
    sessionStorage.setItem('bulwark-lite:pending-path', '/de/calendar/day/2026-11-04');
    localStorage.setItem('calendar-storage', JSON.stringify({ state: { viewMode: 'week' } }));
    boot('/de/calendar/');
    expect(attr('calendar-view')).toBe('week');
  });

  it('strips the base path and the Lite mount', () => {
    boot('/webmail/en/files/Docs', { basePath: '/webmail' });
    expect(attr('surface')).toBe('files');
    (window as unknown as Record<string, unknown>).__BULWARK_LITE_MOUNT__ = '/bulwark';
    try {
      boot('/bulwark/en/settings/filters', { lite: true });
      expect(attr('surface')).toBe('settings');
      expect(attr('settings-tab')).toBe('filters');
    } finally {
      delete (window as unknown as Record<string, unknown>).__BULWARK_LITE_MOUNT__;
    }
  });
});

describe('boot script: cached theme', () => {
  it('puts the cached theme and skin back before the page renders', () => {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ v: 1, css: ':root{--color-primary:red}', skin: 'html[data-theme-skin="t1"] body{font-family:x}', skinId: 't1' }));
    boot('/en/mail');
    expect(document.getElementById('active-theme')?.textContent).toBe(':root{--color-primary:red}');
    expect(document.getElementById('active-theme-skin')?.textContent).toContain('font-family:x');
    expect(html().getAttribute('data-theme-skin')).toBe('t1');
  });

  it('reuses existing elements instead of adding a second copy', () => {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ v: 1, css: 'a{}' }));
    boot('/en/mail');
    boot('/en/mail');
    expect(document.querySelectorAll('#active-theme')).toHaveLength(1);
  });

  it('ignores a cache from another format version, or a skin without its id', () => {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ v: 2, css: 'a{}' }));
    boot('/en/mail');
    expect(document.getElementById('active-theme')).toBeNull();
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ v: 1, skin: 'b{}' }));
    boot('/en/mail');
    expect(document.getElementById('active-theme-skin')).toBeNull();
  });
});
