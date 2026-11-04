/**
 * The pre-paint half of the page skeletons.
 *
 * The server renders every variant a skeleton can take; CSS shows the right
 * one from attributes on <html>. Those attributes come from the browser's own
 * state (localStorage, the URL, the viewport), so the inline script in
 * app/(main)/layout.tsx sets them before the first paint by running
 * `applyBootLayout` and `applyBootTheme` below.
 *
 * Both functions are stringified into that script. They must stay
 * self-contained: no imports, no module constants, no syntax that compiles to
 * a helper call (object spread, rest destructuring). Everything they need from
 * the app arrives in the `c` argument, built on the server by `bootConfig()`.
 * lib/boot-skeleton/__tests__/boot-script.test.ts runs the real script string.
 *
 * Every read is wrapped: missing or corrupt storage, blocked storage and odd
 * URLs all fall back to the default layout.
 */

import { locales } from '@/i18n/routing';
import { DEFAULT_DENSITY, MOUNTAIN_VIEW_DENSITY } from '@/lib/density';
import { IS_LITE, LITE_MOUNT_GLOBAL, LITE_PENDING_PATH_KEY } from '@/lib/lite';
import { LEGACY_TAB_MAP, SETTINGS_TAB_IDS } from '@/lib/settings-tabs';
import { CALENDAR_VIEWS, CONNECTOR_SURFACES, PROTOCOL_SURFACES, PRO_SURFACES, SIGNED_IN_SURFACES } from './surfaces';
import { BOOT_HINTS_KEY, THEME_CACHE_KEY } from './keys';

export { BOOT_HINTS_KEY, THEME_CACHE_KEY };

export interface BootLayoutConfig {
  locales: string[];
  basePath: string;
  lite: boolean;
  liteMount: string;
  pendingKey: string;
  density: Record<string, Record<string, string>>;
  mvDensity: Record<string, Record<string, string>>;
  legacyTabs: Record<string, string>;
  tabs: string[];
  calendarViews: string[];
  connector: Record<string, string>;
  protocol: Record<string, string>;
  pro: string[];
  signedIn: string[];
  hintsKey: string;
}

export function bootConfig(): BootLayoutConfig {
  return {
    locales: [...locales],
    basePath: (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, ''),
    lite: IS_LITE,
    liteMount: LITE_MOUNT_GLOBAL,
    pendingKey: LITE_PENDING_PATH_KEY,
    density: DEFAULT_DENSITY,
    mvDensity: MOUNTAIN_VIEW_DENSITY,
    legacyTabs: LEGACY_TAB_MAP,
    tabs: [...SETTINGS_TAB_IDS],
    calendarViews: [...CALENDAR_VIEWS],
    connector: CONNECTOR_SURFACES,
    protocol: PROTOCOL_SURFACES,
    pro: [...PRO_SURFACES],
    signedIn: [...SIGNED_IN_SURFACES],
    hintsKey: BOOT_HINTS_KEY,
  };
}

/**
 * Sets the skeleton's variant attributes (`data-boot-*`), its size variables
 * (`--boot-*`), `data-interface-layout` and the density variables on `root`.
 */
export function applyBootLayout(root: HTMLElement, c: BootLayoutConfig): void {
  var w = window as unknown as Record<string, unknown> & Window;
  var readLocal = function (key: string): string | null {
    try { return w.localStorage.getItem(key); } catch { return null; }
  };
  var readSession = function (key: string): string | null {
    try { return w.sessionStorage.getItem(key); } catch { return null; }
  };
  var parse = function (raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch { return null; }
  };
  var stateOf = function (key: string): Record<string, unknown> {
    var v = parse(readLocal(key));
    var s = v && v.state;
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  };
  var mark = function (name: string, value: string | null | false) {
    if (value) root.setAttribute('data-boot-' + name, value);
    else root.removeAttribute('data-boot-' + name);
  };
  var size = function (name: string, raw: unknown, def: number, min: number, max: number) {
    var n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
    if (!isFinite(n) || n <= 0) n = def;
    if (min > 0 && n < min) n = min;
    if (max > 0 && n > max) n = max;
    root.style.setProperty('--boot-' + name, Math.round(n) + 'px');
  };
  var has = function (list: string[], value: unknown): value is string {
    return typeof value === 'string' && list.indexOf(value) !== -1;
  };

  // --- Where are we? ---------------------------------------------------
  var path = '';
  var search = '';
  try {
    path = w.location.pathname || '';
    search = w.location.search || '';
  } catch { /* keep the defaults */ }
  if (c.lite) {
    // A Lite host without rewrites parks the deep link and replays it on the
    // surface root (scripts/lite/lib.mjs, buildNotFoundShim).
    var parked = readSession(c.pendingKey);
    if (parked) {
      var cut = parked.indexOf('?');
      path = cut === -1 ? parked : parked.slice(0, cut);
      if (cut !== -1) search = parked.slice(cut);
    }
  }
  var mount = c.basePath;
  if (!mount && c.lite && typeof w[c.liteMount] === 'string') mount = w[c.liteMount] as string;
  if (mount && path.indexOf(mount) === 0) path = path.slice(mount.length);
  var seg = path.split('/').filter(function (s) { return s !== ''; });
  for (var i = 0; i < seg.length; i++) {
    try { seg[i] = decodeURIComponent(seg[i]); } catch { /* keep it encoded */ }
  }
  if (seg.length && c.locales.indexOf(seg[0]) !== -1) seg.shift();
  var query = function (name: string): string | null {
    try { return new URLSearchParams(search).get(name); } catch { return null; }
  };

  var surface = '';
  var via = '';
  var first = seg[0] || '';
  if (first === 'connector') {
    // Draw the destination: rebuild the segments its path would have from
    // the link's parameters (lib/connector/registry.ts).
    var target = seg[1] || '';
    via = 'connector';
    surface = c.connector[target] || '';
    if (target === 'calendar') seg = ['calendar', query('view') || 'month'];
    else if (target === 'settings') seg = ['settings', query('tab') || ''];
    else if (target === 'admin') seg = ['admin', query('tab') || ''];
    else if (surface === 'admin') seg = ['admin', target];
    else seg = [surface];
    first = seg[0];
  } else if (first === 'protocol') {
    via = seg[1] || '';
    surface = c.protocol[via] || '';
    if (!surface) via = '';
    seg = [surface];
  } else if (first === '' || first === 'mail') surface = 'mail';
  else if (first === 'admin') surface = seg[1] === 'login' ? 'admin-login' : 'admin';
  else if (['calendar', 'contacts', 'files', 'apps', 'settings', 'pro', 'login', 'setup'].indexOf(first) !== -1) surface = first;
  mark('surface', surface);
  mark('via', via);

  // --- Settings the layout depends on ----------------------------------
  var s = stateOf('settings-storage');
  var layout = s.interfaceLayout === 'mountain-view' ? 'mountain-view' : 'default';
  // The same attribute and variables applyInterfaceLayout/applyDensity write
  // once JS runs (stores/settings-store.ts), set before the first paint.
  root.setAttribute('data-interface-layout', layout);
  var density = typeof s.density === 'string' && c.density[s.density] ? s.density : 'regular';
  var vars = (layout === 'mountain-view' ? c.mvDensity : c.density)[density];
  for (var prop in vars) root.style.setProperty(prop, vars[prop]);
  // Which rows the mail list draws: avatars and previews depend on these.
  mark('density', density);
  mark('preview', s.showPreview === false ? 'off' : null);

  var mailLayout = s.mailLayout === 'focus' || s.mailLayout === 'horizontal' ? s.mailLayout : 'split';
  if (layout === 'mountain-view' || s.simpleMode === true) mailLayout = 'focus';
  mark('mail-layout', mailLayout);
  // Compose at the head of the folder sidebar in place of the account
  // switcher (sidebarAccountSwitcher off); otherwise it sits under it.
  mark('sidebar-compose', s.sidebarAccountSwitcher === false ? 'on' : null);

  var desktop = false;
  // The desktop layout, compact included (PHONE_BELOW in hooks/use-media-query).
  try { desktop = w.matchMedia('(min-width: 37.5rem)').matches; } catch { /* assume not */ }
  var proOn = s.proInterface === true && desktop && (surface === 'pro' || has(c.pro, surface));
  mark('pro', proOn ? 'on' : null);

  // --- Pro tabs ----------------------------------------------------------
  // What the Pro shell will show (stores/pro-tab-store.ts, normalizeProTabState):
  // each pane's tabs and its active tab, after the redirect from a standard
  // page has opened or focused that page's tab (ProInterfaceRedirect, openTab).
  var proShows: string[] = [];
  var proTabs: { id: unknown; kind: string; pane: string }[] = [];
  var proState = proOn ? stateOf('pro-tabs') : {};
  var rawTabs = Array.isArray(proState.tabs) ? (proState.tabs as unknown[]) : [];
  for (var t = 0; t < rawTabs.length; t++) {
    var rt = rawTabs[t] as Record<string, unknown> | null;
    if (rt && typeof rt === 'object' && typeof rt.kind === 'string') {
      proTabs.push({ id: rt.id, kind: rt.kind, pane: rt.paneId === 'split' ? 'split' : 'main' });
    }
  }
  if (!proTabs.length) proTabs.push({ id: 'home-mail', kind: 'mail', pane: 'main' });
  var activeMain = proState.activeTabId;
  var activeSplit = proState.activeSplitTabId;
  var inPane = function (which: string) {
    return proTabs.filter(function (tab) { return tab.pane === which; });
  };
  if (!inPane('main').length) {
    // An empty main pane takes the split pane's tabs over.
    for (var m = 0; m < proTabs.length; m++) proTabs[m].pane = 'main';
    activeMain = activeSplit;
    activeSplit = null;
  }
  var proFocus = proState.focusedPaneId === 'split' && inPane('split').length ? 'split' : 'main';
  if (proOn && surface !== 'pro') {
    var opened = null as { id: unknown; kind: string; pane: string } | null;
    for (var o = 0; o < proTabs.length && !opened; o++) if (proTabs[o].kind === surface) opened = proTabs[o];
    if (!opened) {
      opened = { id: '#boot-opened', kind: surface, pane: proFocus };
      proTabs.push(opened);
    }
    if (opened.pane === 'split') activeSplit = opened.id;
    else activeMain = opened.id;
    proFocus = opened.pane;
  }
  var proPane = function (which: string, activeId: unknown): string {
    var list = inPane(which);
    if (!proOn || !list.length) {
      mark('pro-' + which + '-tabs', null);
      mark('pro-' + which + '-active', null);
      mark('pro-' + which + '-kind', null);
      return '';
    }
    var at = 0;
    for (var p = 0; p < list.length; p++) if (list[p].id === activeId) at = p;
    var kind = list[at].kind;
    // The skeleton draws up to eight tabs; a longer strip scrolls anyway.
    mark('pro-' + which + '-tabs', String(Math.min(list.length, 8)));
    mark('pro-' + which + '-active', String(Math.min(at, 7)));
    mark('pro-' + which + '-kind', has(c.pro, kind) ? kind : 'other');
    proShows.push(kind);
    return kind;
  };
  var mainKind = proPane('main', activeMain);
  var splitKind = proPane('split', activeSplit);
  mark('pro-split', proOn && splitKind ? (proState.splitSide === 'left' ? 'left' : 'right') : null);
  mark('pro-focus', proOn ? proFocus : null);
  mark('pro-kind', proOn ? (proFocus === 'split' ? splitKind : mainKind) : null);

  // --- Which pane is open ----------------------------------------------
  var pane = '';
  if (surface === 'mail') {
    if ((seg[1] === 'message' || seg[1] === 'thread') && seg[2]) pane = seg[1];
    else if (query('email')) pane = 'message';
  } else if (surface === 'contacts') {
    // The new-contact form needs no data, so it is drawn for what it is.
    if (seg[1] === 'new' || (!seg[1] && !query('contactId') && query('addEmail'))) pane = 'create';
    else if (seg[1] || query('contactId')) pane = 'detail';
  } else if (surface === 'admin') {
    if (seg[1]) pane = 'detail';
  }

  // A Pro pane showing settings or the calendar needs their variants too.
  if (surface === 'settings' || proShows.indexOf('settings') !== -1) {
    var migrate = function (raw: string | null): string | null {
      if (!raw) return null;
      var id = c.legacyTabs[raw] || raw;
      return has(c.tabs, id) ? id : null;
    };
    var linked = migrate(surface === 'settings' ? seg[1] || null : null) || migrate(readSession('settings-deep-link-tab'));
    if (linked && surface === 'settings') pane = 'detail';
    mark('settings-tab', linked || migrate(readLocal('settings-active-tab')) || 'appearance');
  } else mark('settings-tab', null);
  mark('pane', pane);

  // --- Calendar ----------------------------------------------------------
  if (surface === 'calendar' || proShows.indexOf('calendar') !== -1) {
    var view = surface === 'calendar' ? seg[1] || '' : '';
    var calView = has(c.calendarViews, view) ? view : '';
    if (!calView && /^\d{4}-\d{2}-\d{2}$/.test(view)) calView = 'month';
    if (!calView) {
      var stored = stateOf('calendar-storage').viewMode;
      calView = has(c.calendarViews, stored) ? stored : 'month';
    }
    mark('calendar-view', calView);
    // Week columns: every day, or the working days when the rest are hidden
    // (lib/calendar-display-range.ts, resolveWorkingDays).
    var cols = 7;
    if (s.calendarHideNonWorkingDays === true && Array.isArray(s.calendarWorkingDays)) {
      var days: number[] = [];
      for (var d = 0; d < s.calendarWorkingDays.length; d++) {
        var day = s.calendarWorkingDays[d];
        if (typeof day === 'number' && day % 1 === 0 && day >= 0 && day <= 6 && days.indexOf(day) === -1) days.push(day);
      }
      if (days.length > 0 && days.length < 7) cols = days.length;
    }
    root.style.setProperty('--boot-cal-cols', String(cols));
    // Hour rows: the limited display range, or the whole day (resolveDisplayHours).
    var start = s.calendarDayStartHour === undefined ? 8 : s.calendarDayStartHour;
    var end = s.calendarDayEndHour === undefined ? 20 : s.calendarDayEndHour;
    var hours = 24;
    if (s.calendarLimitHours !== false && typeof start === 'number' && typeof end === 'number'
      && start % 1 === 0 && end % 1 === 0 && start >= 0 && end <= 24 && end > start && !(start === 0 && end === 24)) {
      hours = end - start;
    }
    root.style.setProperty('--boot-cal-hours', String(hours));
    var firstHour = hours === 24 ? 0 : (start as number);
    root.style.setProperty('--boot-cal-start', String(firstHour));
    // The wall clock in the calendar's time zone (lib/timezone.ts, displayNow).
    var now = new Date();
    var clock = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours()];
    if (typeof s.timeZone === 'string' && s.timeZone && s.timeZone !== 'auto') {
      try {
        var parts = new Intl.DateTimeFormat('en-US', {
          timeZone: s.timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
        }).formatToParts(now);
        var names = ['year', 'month', 'day', 'hour'];
        for (var p = 0; p < parts.length; p++) {
          var at = names.indexOf(parts[p].type);
          if (at !== -1) clock[at] = Number(parts[p].value) % (at === 3 ? 24 : 100000);
        }
      } catch { /* an unknown zone: the browser's own, as resolveTimeZone does */ }
    }
    // The hour row a time grid opens at (hooks/use-display-hours.ts): an hour
    // before now when now is inside the shown hours, else the top (-1).
    var nowHour = clock[3];
    root.style.setProperty('--boot-cal-scroll', String(nowHour >= firstHour && nowHour < firstHour + hours ? nowHour - 1 - firstHour : -1));
    // Week rows of the sidebar's mini month: the linked date's month, else
    // this one (calendar-app.tsx, miniMonth).
    var linkDate = /^\d{4}-\d{2}-\d{2}$/.test(seg[2] || '') ? seg[2] : /^\d{4}-\d{2}-\d{2}$/.test(view) ? view : '';
    var year = linkDate ? Number(linkDate.slice(0, 4)) : clock[0];
    var month = linkDate ? Number(linkDate.slice(5, 7)) : clock[1];
    var weekStart = s.firstDayOfWeek === 0 ? 0 : s.firstDayOfWeek === 6 ? 6 : 1;
    var lead = (new Date(year, month - 1, 1).getDay() - weekStart + 7) % 7;
    var rows = Math.ceil((lead + new Date(year, month, 0).getDate()) / 7);
    root.style.setProperty('--boot-cal-mini-rows', String(rows >= 4 && rows <= 6 ? rows : 6));
    mark('cal-weeknums', s.showWeekNumbers === true ? 'on' : null);
    // Tasks add a view pill and a sidebar row (enableCalendarTasks).
    mark('cal-tasks', s.enableCalendarTasks === true ? 'on' : null);
  } else {
    mark('calendar-view', null);
    mark('cal-weeknums', null);
    mark('cal-tasks', null);
  }

  // --- Sizes the user dragged ------------------------------------------
  var widths = parse(readLocal('column-widths')) || {};
  size('mail-sidebar-w', widths.sidebarWidth, 256, 180, 400);
  size('mail-list-w', widths.emailListWidth, 384, 240, 600);
  size('mail-list-h', widths.emailListHeight, 320, 160, 800);
  size('cal-sidebar-w', readLocal('calendar-sidebar-width'), 256, 0, 0);
  size('contacts-sidebar-w', readLocal('contacts-sidebar-width'), 256, 0, 0);
  size('contacts-list-w', readLocal('contacts-list-width'), 384, 0, 0);
  size('files-sidebar-w', readLocal('files-sidebar-width'), 256, 180, 400);
  size('settings-nav-w', readLocal('settings-sidebar-width'), 256, 0, 0);
  mark('collapsed', readLocal('calendar-sidebar-collapsed') === '1' ? 'calendar' : null);
  var files = s.filesSettings as Record<string, unknown> | undefined;
  mark('files-view', files && files.defaultViewMode === 'grid' ? 'grid' : 'list');
  mark('files-details', readLocal('files-show-details') === '1' ? 'on' : null);

  // --- What the last session showed ------------------------------------
  var hints = parse(readLocal(c.hintsKey));
  var rail = hints && Array.isArray(hints.rail)
    ? (hints.rail as unknown[]).filter(function (r) { return typeof r === 'string' && /^[a-z-]+$/.test(r); })
    : null;
  mark('rail', rail && rail.length ? rail.join(' ') : null);
  // The settings pages the nav listed: the skeleton hides the optional ones
  // that weren't there. Pages only, from the known list.
  var settingsTabs = hints && Array.isArray(hints.settings)
    ? (hints.settings as unknown[]).filter(function (t) { return has(c.tabs, t); })
    : null;
  mark('settings-tabs', settingsTabs && settingsTabs.length ? settingsTabs.join(' ') : null);

  // --- Probably signed out? --------------------------------------------
  // No redirect here: a cookie-only session (impersonation, a server hand-off)
  // is invisible to this script and still gets adopted by checkAuth. The
  // skeleton only takes the login card's shape instead of the app's.
  var out = false;
  if (has(c.signedIn, surface) && query('impersonated') !== '1') {
    var authed = stateOf('auth-storage').isAuthenticated === true;
    var accounts = stateOf('account-registry').accounts;
    var keeps = false;
    if (Array.isArray(accounts)) {
      for (var a = 0; a < accounts.length; a++) {
        var acct = accounts[a];
        if (acct && (acct.rememberMe === true || c.lite || acct.serverUrl === 'https://demo.example.com')) keeps = true;
      }
    }
    out = !authed && !keeps;
  }
  mark('auth', out ? 'out' : null);
}

/**
 * Puts the last applied theme back before the first paint: the colour block
 * as `<style id="active-theme">`, the skin as `<style id="active-theme-skin">`.
 * lib/theme-loader.ts writes the cache and later overwrites these same
 * elements with the same text, so nothing changes when the theme loads.
 *
 * <body> does not exist yet, so the cached skin is stored with its
 * `body[data-theme-skin=…]` selectors rewritten to hang off <html>, and the
 * attribute goes on <html> here.
 */
export function applyBootTheme(doc: Document, key: string): void {
  var cached: Record<string, unknown> | null = null;
  try { cached = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch { return; }
  if (!cached || typeof cached !== 'object' || cached.v !== 1) return;
  var put = function (id: string, css: unknown) {
    if (typeof css !== 'string' || !css) return;
    var el = doc.getElementById(id) || doc.createElement('style');
    el.id = id;
    el.textContent = css;
    if (!el.parentNode) doc.head.appendChild(el);
  };
  put('active-theme', cached.css);
  if (typeof cached.skinId === 'string' && cached.skinId) {
    put('active-theme-skin', cached.skin);
    doc.documentElement.setAttribute('data-theme-skin', cached.skinId);
  }
}

/** The part of the inline <head> script that runs both functions. */
export function bootSkeletonScript(config: BootLayoutConfig = bootConfig()): string {
  return `try{(${applyBootLayout.toString()})(document.documentElement,${JSON.stringify(config)});}catch(e){}`
    + `try{(${applyBootTheme.toString()})(document,${JSON.stringify(THEME_CACHE_KEY)});}catch(e){}`;
}
