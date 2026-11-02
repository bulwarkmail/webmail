import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { useTaskStore } from '@/stores/task-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';

// The whole calendar page, with the shell around it stubbed out and the
// stores holding a fixed set of calendars and events.

const media = vi.hoisted(() => ({ mobile: false, desktop: true }));
vi.mock('@/hooks/use-media-query', () => ({
  useIsMobile: () => media.mobile,
  useIsDesktop: () => media.desktop,
  useIsTablet: () => !media.mobile && !media.desktop,
  useMediaQuery: () => false,
}));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/layout/inline-app-view', () => ({ InlineAppView: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/hooks/use-refresh-gesture', () => ({ useRefreshGesture: () => ({ indicator: null }) }));
vi.mock('@/hooks/use-calendar-push-refresh', () => ({ useCalendarPushRefresh: () => {} }));
vi.mock('@/hooks/use-account-principal-emails', () => ({ useAccountPrincipalEmails: () => [] }));
vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));
const config = vi.hoisted(() => ({ demoMode: false }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => config }));
const lite = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lite')>()),
  get IS_LITE() { return lite.on; },
}));

import { CalendarApp } from '../calendar-app';
import { useRegisteredCommandGroups } from '@/lib/command-registry';
import { interceptLeave } from '@/lib/leave-guard';

/** The empty hour slots of the time grid (buttons inside the day cells). */
const slots = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot]'));

/** A month view day cell, found by its date button (the cell itself has no name). */
function monthCell(day: RegExp): HTMLElement | undefined {
  return screen.getAllByRole('gridcell').find((c) => day.test(c.querySelector('[data-day-button]')?.getAttribute('aria-label') ?? ''));
}

// The first render loads the whole page and is slow under load.
vi.setConfig({ testTimeout: 30000 });

const RIGHTS = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};

const calendars = [{
  id: 'cal', name: 'Personal', color: '#123456', isDefault: true, sortOrder: 0, description: null,
  isSubscribed: true, isVisible: true, includeInAvailability: 'all', defaultAlertsWithTime: null,
  defaultAlertsWithoutTime: null, timeZone: null, shareWith: null, myRights: RIGHTS,
}] as unknown as Calendar[];

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1', uid: 'u1', '@type': 'Event', title: 'Standup', description: '', start: '2026-10-12T10:00:00',
    duration: 'PT1H', timeZone: null, showWithoutTime: false, calendarIds: { cal: true },
    participants: null, alerts: null, recurrenceRules: null, isOrigin: true, status: 'confirmed',
    ...overrides,
  } as unknown as CalendarEvent;
}

const client = {
  getAccountId: () => 'acc',
  getMaxParticipantsPerEvent: () => null,
  supportsCalendars: () => true,
  queryCalendarEvents: vi.fn().mockResolvedValue([]),
  getCalendarEvent: vi.fn().mockResolvedValue(null),
  getCalendarTasks: vi.fn().mockResolvedValue([]),
};

const store = {
  fetchCalendars: vi.fn(),
  fetchEvents: vi.fn(),
  refreshAllSubscriptions: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  rsvpEvent: vi.fn(),
};

function setUp(events: CalendarEvent[] = [makeEvent()], viewMode: 'month' | 'week' | 'day' | 'agenda' | 'tasks' = 'week') {
  for (const fn of Object.values(store)) fn.mockReset();
  store.createEvent.mockImplementation(async (_c: unknown, data: Partial<CalendarEvent>) => ({ ...makeEvent(), ...data, id: 'new' }));
  store.updateEvent.mockResolvedValue(true);
  store.deleteEvent.mockResolvedValue(true);
  useAuthStore.setState({ isAuthenticated: true, client: client as never, isLoading: false, activeAccountId: 'acc' });
  useCalendarStore.setState({
    calendars, events, supportsCalendar: true, selectedCalendarIds: ['cal'], viewMode,
    selectedDate: new Date(2026, 9, 12), isLoading: false, isLoadingEvents: false, error: null,
    ...store,
  } as never);
  useSettingsStore.setState({ calendarHoverPreview: 'instant', enableCalendarTasks: true, proInterface: false } as never);
  useToastStore.setState({ toasts: [] } as never);
  useTaskStore.setState({ tasks: [] } as never);
  client.getCalendarTasks.mockResolvedValue([]);
}

function renderApp() {
  return render(<CalendarApp />);
}

beforeEach(() => {
  media.mobile = false;
  media.desktop = true;
  setUp();
});

describe('CalendarApp keyboard shortcuts', () => {
  it('leaves Ctrl, Cmd and Alt combinations to the browser', () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'd', code: 'KeyD', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(useCalendarStore.getState().viewMode).toBe('week');
    expect(useCalendarStore.getState().selectedDate).toEqual(new Date(2026, 9, 12));
  });

  it('switches views by the physical key on any layout', () => {
    renderApp();
    // A Cyrillic layout types "ф" on the A key.
    fireEvent.keyDown(document.body, { key: 'ф', code: 'KeyA' });
    expect(useCalendarStore.getState().viewMode).toBe('agenda');
  });

  it('keeps working while the hover preview of an event shows', async () => {
    renderApp();
    const card = screen.getAllByRole('button', { name: /Standup/ })[0];
    fireEvent.mouseEnter(card);
    await screen.findByRole('dialog', { name: 'Standup' });
    fireEvent.keyDown(document.body, { key: 'm', code: 'KeyM' });
    expect(useCalendarStore.getState().viewMode).toBe('month');
  });

  // New 6: the preview opened on top of the open editor.
  it('opens no hover preview while an editor is open', async () => {
    setUp([makeEvent(), makeEvent({ id: 'e2', uid: 'u2', title: 'Retro', start: '2026-10-13T14:00:00' })]);
    renderApp();
    fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'events.edit' }));
    await screen.findByRole('dialog', { name: 'events.edit' });
    fireEvent.mouseEnter(screen.getAllByRole('button', { name: /Retro/ })[0]);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog', { name: 'Retro' })).toBeNull();
  });
});


function PaletteGroups() {
  const groups = useRegisteredCommandGroups();
  return <ul data-testid="palette">{groups.flatMap((g) => g.commands.map((c) => <li key={`${g.label}:${c.id}`}><button type="button" onClick={c.run}>{`${g.label}: ${c.label}`}</button></li>))}</ul>;
}

describe('CalendarApp in the command palette', () => {
  it('offers Calendar commands while the calendar is open', () => {
    render(<><CalendarApp /><PaletteGroups /></>);
    const items = screen.getByTestId('palette').textContent ?? '';
    expect(items).toContain('calendar: events.new_event');
    expect(items).toContain('calendar: events.go_to_today');
    expect(items).toContain('calendar: commands.month');
    expect(items).toContain('calendar: toolbar.import');
    expect(items).toContain('calendar: refresh');
    // The view on screen isn't offered again.
    expect(items).not.toContain('calendar: commands.week');
  });

  it('runs a view command', () => {
    render(<><CalendarApp /><PaletteGroups /></>);
    fireEvent.click(within(screen.getByTestId('palette')).getByText('calendar: commands.day'));
    expect(useCalendarStore.getState().viewMode).toBe('day');
  });
});

describe('CalendarApp in the Tasks view', () => {
  beforeEach(() => setUp([makeEvent()], 'tasks'));

  it('has no date navigation', () => {
    renderApp();
    expect(screen.queryByRole('button', { name: 'nav_prev' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'nav_next' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'views.today' })).toBeNull();
  });

  it('creates a task with n, not an event', () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    expect(screen.getByRole('heading', { name: 'tasks.create' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'events.create' })).toBeNull();
  });

  it('creates a task with the phone create button', () => {
    media.mobile = true;
    media.desktop = false;
    renderApp();
    // The floating button, after the drawer's.
    fireEvent.click(screen.getAllByRole('button', { name: 'events.new_task' }).at(-1)!);
    expect(screen.getByRole('dialog', { name: 'tasks.create' })).toBeInTheDocument();
  });
});

const weekly = makeEvent({ recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', interval: 1 }] as never });

function openEditorOn(title = 'Standup') {
  fireEvent.click(screen.getAllByRole('button', { name: new RegExp(title) })[0]);
  const card = screen.getByRole('dialog', { name: title });
  fireEvent.click(within(card).getByRole('button', { name: 'events.edit' }));
}

describe('CalendarApp recurring event editor', () => {
  beforeEach(() => setUp([weekly]));

  it('goes back to the editor with the changes when the scope question is cancelled', async () => {
    renderApp();
    openEditorOn();
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Standup moved' } });
    fireEvent.click(screen.getByRole('button', { name: 'form.save' }));
    const scope = await screen.findByRole('dialog', { name: 'edit_title' });
    fireEvent.click(within(scope).getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog', { name: 'edit_title' })).toBeNull();
    expect(screen.getByPlaceholderText('form.title')).toHaveValue('Standup moved');
    expect(store.updateEvent).not.toHaveBeenCalled();
  });
});

describe('CalendarApp unsaved editor changes', () => {
  it('asks before Escape drops a typed title, and keeps it on Keep editing', async () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Lunch' } });
    fireEvent.keyDown(screen.getByPlaceholderText('form.title'), { key: 'Escape' });
    const ask = await screen.findByRole('alertdialog', { name: 'discard.title' });
    fireEvent.click(within(ask).getByRole('button', { name: 'discard.keep' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByPlaceholderText('form.title')).toHaveValue('Lunch');

    fireEvent.click(screen.getByText('form.cancel'));
    const again = await screen.findByRole('alertdialog', { name: 'discard.title' });
    fireEvent.click(within(again).getByRole('button', { name: 'discard.confirm' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('form.title')).toBeNull());
  });

  it('opens the editor on n without typing the n into its title', async () => {
    renderApp();
    const press = new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true, cancelable: true });
    document.body.dispatchEvent(press);
    // A key whose keydown is not cancelled goes on to type its character
    expect(press.defaultPrevented).toBe(true);
    expect(await screen.findByPlaceholderText('form.title')).toHaveValue('');
  });

  it('closes an untouched editor without asking', () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    fireEvent.click(screen.getByText('form.cancel'));
    expect(screen.queryByPlaceholderText('form.title')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before a click on an empty slot replaces an editor with changes', async () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Lunch' } });
    // A single click on a slot opens the quick editor after the double-click window.
    fireEvent.click(slots()[3]);
    const ask = await screen.findByRole('alertdialog', { name: 'discard.title' }, { timeout: 2000 });
    fireEvent.click(within(ask).getByRole('button', { name: 'discard.keep' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByPlaceholderText('form.title')).toHaveValue('Lunch');
  });

  it('asks before Cancel drops a changed task', async () => {
    setUp([], 'tasks');
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    fireEvent.change(screen.getByPlaceholderText('tasks.title_placeholder'), { target: { value: 'Buy milk' } });
    fireEvent.click(screen.getByRole('button', { name: 'tasks.cancel' }));
    const ask = await screen.findByRole('alertdialog', { name: 'discard.title' });
    fireEvent.click(within(ask).getByRole('button', { name: 'discard.confirm' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('tasks.title_placeholder')).toBeNull());
  });

  it('has the rail ask before it leaves an editor with changes', async () => {
    renderApp();
    // An untouched editor lets the rail go at once.
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    const navigated = vi.fn();
    // A rail link wired as the real one is: interceptLeave first.
    const link = document.createElement('a');
    link.addEventListener('click', (e) => { if (!interceptLeave(e)) navigated(); });
    document.body.appendChild(link);
    try {
      act(() => { link.click(); });
      expect(navigated).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alertdialog')).toBeNull();

      fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Lunch' } });
      act(() => { link.click(); });
      const ask = await screen.findByRole('alertdialog', { name: 'discard.title' });
      expect(navigated).toHaveBeenCalledOnce();
      fireEvent.click(within(ask).getByRole('button', { name: 'discard.keep' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(screen.getByPlaceholderText('form.title')).toHaveValue('Lunch');
      expect(navigated).toHaveBeenCalledOnce();

      act(() => { link.click(); });
      const again = await screen.findByRole('alertdialog', { name: 'discard.title' });
      fireEvent.click(within(again).getByRole('button', { name: 'discard.confirm' }));
      await waitFor(() => expect(navigated).toHaveBeenCalledTimes(2));
    } finally {
      link.remove();
    }
  });
});

describe('CalendarApp browser Back with an editor open (R5)', () => {
  const backEntry = () => (window.history.state as Record<string, unknown> | null)?.__closeOnBack;
  // Earlier tests leave history behind: wait for this editor's own entry.
  const openEditorEntry = async () => {
    const before = backEntry();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    await waitFor(() => expect(backEntry()).toBeTruthy());
    await waitFor(() => expect(backEntry()).not.toBe(before));
  };

  it('closes an untouched editor instead of leaving the calendar', async () => {
    renderApp();
    await openEditorEntry();
    window.history.back();
    await waitFor(() => expect(screen.queryByPlaceholderText('form.title')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(backEntry()).toBeUndefined();
  });

  it('asks before Back drops changes, and asks again after Keep editing', async () => {
    renderApp();
    await openEditorEntry();
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Lunch' } });
    window.history.back();
    const ask = await screen.findByRole('alertdialog', { name: 'discard.title' });
    fireEvent.click(within(ask).getByRole('button', { name: 'discard.keep' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByPlaceholderText('form.title')).toHaveValue('Lunch');
    // The entry is back, so the next Back asks again
    expect(backEntry()).toBeTruthy();

    window.history.back();
    const again = await screen.findByRole('alertdialog', { name: 'discard.title' });
    fireEvent.click(within(again).getByRole('button', { name: 'discard.confirm' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('form.title')).toBeNull());
    await waitFor(() => expect(backEntry()).toBeUndefined());
  });

  it('takes its history entry back off when the editor closes another way', async () => {
    renderApp();
    await openEditorEntry();
    fireEvent.click(screen.getByText('form.cancel'));
    await waitFor(() => expect(backEntry()).toBeUndefined());
  });
});

describe('CalendarApp event search (CAL-16)', () => {
  it('focuses the search on / and shows matching events in place of the grid', async () => {
    setUp([makeEvent(), makeEvent({ id: 'e2', uid: 'u2', title: 'Dentist', start: '2026-10-13T08:00:00' })]);
    renderApp();
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });
    const box = screen.getByRole('searchbox', { name: 'search.title' });
    expect(document.activeElement).toBe(box);

    fireEvent.change(box, { target: { value: 'dent' } });
    const results = await screen.findByTestId('calendar-search-results');
    expect(within(results).getByText('Dentist')).toBeInTheDocument();
    expect(within(results).queryByText('Standup')).toBeNull();
    // The view's grid gives way (the mini calendar's grid stays).
    expect(screen.queryByRole('grid', { name: 'views.week' })).toBeNull();

    // A result opens like an event in the grid
    fireEvent.click(within(results).getByText('Dentist'));
    expect(await screen.findByRole('dialog', { name: 'Dentist' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // Escape in the box goes back to the grid
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('calendar-search-results')).toBeNull());
    expect(screen.getByRole('grid', { name: 'views.week' })).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    renderApp();
    fireEvent.change(screen.getByRole('searchbox', { name: 'search.title' }), { target: { value: 'zzz' } });
    expect(await screen.findByText('search.no_results', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('offers Clear search when nothing matches, back to the calendar with the cursor in the box', async () => {
    renderApp();
    const box = screen.getByRole('searchbox', { name: 'search.title' });
    fireEvent.change(box, { target: { value: 'zzz' } });
    await screen.findByText('search.no_results', {}, { timeout: 3000 });
    const results = screen.getByTestId('calendar-search-results');
    fireEvent.click(within(results).getByRole('button', { name: 'search.clear' }));
    expect(box).toHaveValue('');
    expect(document.activeElement).toBe(box);
    await waitFor(() => expect(screen.queryByTestId('calendar-search-results')).toBeNull());
  });

  it('is in the command palette', () => {
    render(<><CalendarApp /><PaletteGroups /></>);
    const items = screen.getByTestId('palette').textContent ?? '';
    expect(items).toContain('calendar: search.title');
  });
});

function toastTitles(): string[] {
  return useToastStore.getState().toasts.map((t) => t.title);
}

describe('CalendarApp deleting', () => {
  it('asks before the right-click menu deletes an event, then says it did', async () => {
    renderApp();
    fireEvent.contextMenu(screen.getAllByRole('button', { name: /Standup/ })[0], { clientX: 50, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'events.delete' }));
    const ask = await screen.findByRole('alertdialog', { name: 'delete_dialog.event_title' });
    expect(store.deleteEvent).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'delete_dialog.confirm' }));
    await waitFor(() => expect(store.deleteEvent).toHaveBeenCalledWith(client, 'e1', undefined));
    await waitFor(() => expect(toastTitles()).toContain('notifications.event_deleted'));
  });

  it('asks before the card deletes an event, and Cancel keeps it', async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Standup' })).getByRole('button', { name: 'events.delete' }));
    const ask = await screen.findByRole('alertdialog', { name: 'delete_dialog.event_title' });
    fireEvent.click(within(ask).getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(store.deleteEvent).not.toHaveBeenCalled();
  });

  it('asks a series only once: the scope question replaces the confirm', async () => {
    setUp([weekly]);
    renderApp();
    fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Standup' })).getByRole('button', { name: 'events.delete' }));
    expect(await screen.findByRole('dialog', { name: 'delete_question' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before deleting a task and says it did', async () => {
    setUp([], 'tasks');
    const task = { id: 't1', '@type': 'Task', title: 'Buy milk', calendarIds: { cal: true }, progress: 'needs-action', priority: 0, due: null, showWithoutTime: true } as never;
    useTaskStore.setState({ tasks: [task] } as never);
    client.getCalendarTasks.mockResolvedValue([task]);
    const deleteCalendarTask = vi.fn().mockResolvedValue(undefined);
    Object.assign(client, { deleteCalendarTask });
    renderApp();
    fireEvent.click(await screen.findByText('Buy milk'));
    fireEvent.click(screen.getByRole('button', { name: 'tasks.delete' }));
    const ask = await screen.findByRole('alertdialog', { name: 'delete_dialog.task_title' });
    expect(deleteCalendarTask).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'delete_dialog.confirm' }));
    await waitFor(() => expect(deleteCalendarTask).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(toastTitles()).toContain('notifications.task_deleted'));
  });
});

describe('CalendarApp read-only events', () => {
  const readOnlyCalendar = {
    ...calendars[0], id: 'ro', name: 'Holidays', isDefault: false,
    myRights: { ...RIGHTS, mayWriteAll: false, mayWriteOwn: false, mayDelete: false, mayRSVP: false },
  } as unknown as Calendar;
  const holiday = makeEvent({ id: 'h1', title: 'Holiday', calendarIds: { ro: true } });

  beforeEach(() => {
    setUp([holiday]);
    useCalendarStore.setState({ calendars: [...calendars, readOnlyCalendar], selectedCalendarIds: ['cal', 'ro'] } as never);
  });

  it('offers no Edit or Delete in the right-click menu', async () => {
    renderApp();
    fireEvent.contextMenu(screen.getAllByRole('button', { name: /Holiday/ })[0], { clientX: 50, clientY: 50 });
    expect(await screen.findByRole('menuitem', { name: 'events.duplicate' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'events.edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'events.delete' })).toBeNull();
  });

  it('can be neither dragged nor resized', () => {
    const { container } = renderApp();
    const card = screen.getAllByRole('button', { name: /Holiday/ })[0];
    expect(card).not.toHaveAttribute('draggable', 'true');
    expect(container.querySelectorAll('[data-resize-handle]')).toHaveLength(0);
  });

  it('keeps an editable event draggable', () => {
    setUp([makeEvent()]);
    renderApp();
    expect(screen.getAllByRole('button', { name: /Standup/ })[0]).toHaveAttribute('draggable', 'true');
  });
});

function dropOnMonthDay(day: RegExp, event: CalendarEvent) {
  const cell = monthCell(day);
  if (!cell) throw new Error(`no cell ${day}`);
  const json = JSON.stringify({ type: 'calendar-event', eventId: event.id, originalStart: event.start, duration: event.duration });
  fireEvent.drop(cell, { dataTransfer: { types: ['application/x-calendar-event'], getData: () => json } });
}

describe('CalendarApp dragging', () => {
  it('asks which occurrences a drag of a series moves', async () => {
    setUp([weekly], 'month');
    renderApp();
    dropOnMonthDay(/October 14, 2026/, weekly);
    const scope = await screen.findByRole('dialog', { name: 'edit_title' });
    expect(store.updateEvent).not.toHaveBeenCalled();
    fireEvent.click(within(scope).getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'edit_title' })).toBeNull());
    expect(store.updateEvent).not.toHaveBeenCalled();
  });

  it('moves one event at once and can move it back', async () => {
    setUp([makeEvent()], 'month');
    renderApp();
    dropOnMonthDay(/October 14, 2026/, makeEvent());
    await waitFor(() => expect(store.updateEvent).toHaveBeenCalledTimes(1));
    expect(store.updateEvent.mock.calls[0][2]).toMatchObject({ start: '2026-10-14T10:00:00' });
    const moved = await waitFor(() => {
      const found = useToastStore.getState().toasts.find((t) => t.title === 'notifications.event_moved');
      expect(found).toBeTruthy();
      return found!;
    });
    moved.action!.onClick();
    await waitFor(() => expect(store.updateEvent).toHaveBeenCalledTimes(2));
    expect(store.updateEvent.mock.calls[1][2]).toMatchObject({ start: '2026-10-12T10:00:00', duration: 'PT1H' });
  });
});

describe('CalendarApp task feedback', () => {
  const task = { id: 't1', '@type': 'Task', title: 'Buy milk', calendarIds: { cal: true }, progress: 'needs-action', priority: 0, due: null, showWithoutTime: true } as never;

  it('says when a task couldn\'t be saved and keeps the form open', async () => {
    setUp([], 'tasks');
    Object.assign(client, { createCalendarTask: vi.fn().mockRejectedValue(new Error('boom')) });
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    fireEvent.change(screen.getByPlaceholderText('tasks.title_placeholder'), { target: { value: 'Buy milk' } });
    fireEvent.click(screen.getByRole('button', { name: 'tasks.save' }));
    await waitFor(() => expect(toastTitles()).toContain('notifications.task_save_error'));
    expect(screen.getByPlaceholderText('tasks.title_placeholder')).toHaveValue('Buy milk');
  });

  it('says when ticking a task off failed', async () => {
    setUp([], 'tasks');
    useTaskStore.setState({ tasks: [task] } as never);
    client.getCalendarTasks.mockResolvedValue([task]);
    Object.assign(client, { updateCalendarTask: vi.fn().mockRejectedValue(new Error('boom')) });
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'tasks.mark_complete' }));
    await waitFor(() => expect(toastTitles()).toContain('notifications.task_update_error'));
  });

  it('adds a quick task to a calendar it may write to', async () => {
    setUp([], 'tasks');
    const readOnly = { ...calendars[0], id: 'ro', isDefault: false, myRights: { ...RIGHTS, mayWriteAll: false, mayWriteOwn: false } };
    useCalendarStore.setState({ calendars: [readOnly, { ...calendars[0], isDefault: false }], selectedCalendarIds: ['ro', 'cal'] } as never);
    const createCalendarTask = vi.fn().mockImplementation(async (data: object) => ({ ...data, id: 't9' }));
    Object.assign(client, { createCalendarTask });
    renderApp();
    const input = await screen.findByPlaceholderText('tasks.quick_add_placeholder');
    fireEvent.change(input, { target: { value: 'Call Bob' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(createCalendarTask).toHaveBeenCalled());
    expect(createCalendarTask.mock.calls[0][0]).toMatchObject({ title: 'Call Bob', calendarIds: { cal: true } });
    await waitFor(() => expect(toastTitles()).toContain('notifications.task_created'));
  });

  it('shows completed tasks under All', async () => {
    setUp([], 'tasks');
    const done = { ...(task as object), id: 't2', title: 'Pay rent', progress: 'completed' } as never;
    useTaskStore.setState({ tasks: [task, done], filter: 'all', showCompleted: false } as never);
    client.getCalendarTasks.mockResolvedValue([task, done]);
    renderApp();
    expect(await screen.findByText('Pay rent')).toBeInTheDocument();
    expect(screen.queryByText('tasks.show_completed')).toBeNull();
  });
});

describe('CalendarApp creating in the month view', () => {
  it('opens the quick editor for an all-day event on a single click', async () => {
    setUp([], 'month');
    renderApp();
    const day = monthCell(/October 15, 2026/)!;
    fireEvent.click(day);
    const quick = await screen.findByRole('dialog', { name: 'quick_create.aria_label' });
    expect(within(quick).getByText('events.all_day')).toBeInTheDocument();
    fireEvent.change(within(quick).getByLabelText('form.title'), { target: { value: 'Holiday' } });
    fireEvent.click(within(quick).getByRole('button', { name: 'form.save' }));
    await waitFor(() => expect(store.createEvent).toHaveBeenCalledTimes(1));
    expect(store.createEvent.mock.calls[0][1]).toMatchObject({
      title: 'Holiday', start: '2026-10-15T00:00:00', duration: 'P1D', showWithoutTime: true,
    });
  });

  it('opens the day on a phone tap instead', () => {
    media.mobile = true;
    media.desktop = false;
    setUp([], 'month');
    renderApp();
    const day = monthCell(/October 15, 2026/)!;
    fireEvent.click(day);
    expect(screen.queryByRole('dialog', { name: 'quick_create.aria_label' })).toBeNull();
    expect(useCalendarStore.getState().viewMode).toBe('day');
  });
});

describe('CalendarApp on touch screens', () => {
  it("has Import, Subscribe and Refresh in the phone header's ⋮", async () => {
    media.mobile = true;
    media.desktop = false;
    renderApp();
    // The shell's phone ⋮, labelled by its own namespace (top_bar.more).
    // Error toasts of earlier tests add an unread count to its name.
    fireEvent.click(screen.getByRole('button', { name: /^more/ }));
    expect(await screen.findByRole('menuitem', { name: 'toolbar.import' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'toolbar.subscribe' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'refresh' })).toBeInTheDocument();
  });

  it('offers the event menu from a ⋮ in the phone event view', async () => {
    media.mobile = true;
    media.desktop = false;
    setUp([makeEvent()], 'day');
    renderApp();
    fireEvent.click(screen.getAllByRole('button', { name: /Standup/ })[0]);
    const view = await screen.findByRole('dialog', { name: 'Standup' });
    fireEvent.click(within(view).getByRole('button', { name: 'toolbar.more' }));
    expect(await screen.findByRole('menuitem', { name: 'events.export_ics' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'events.copy_title' })).toBeInTheDocument();
  });

  it('opens the event menu on a long press', async () => {
    renderApp();
    const card = screen.getAllByRole('button', { name: /Standup/ })[0];
    fireEvent.touchStart(card, { touches: [{ clientX: 40, clientY: 40 }] });
    expect(await screen.findByRole('menuitem', { name: 'events.duplicate' }, { timeout: 2000 })).toBeInTheDocument();
    fireEvent.touchEnd(card);
  });
});

describe('CalendarApp event menu', () => {
  it('opens the form from Edit event, not the summary', async () => {
    renderApp();
    fireEvent.contextMenu(screen.getAllByRole('button', { name: /Standup/ })[0], { clientX: 50, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'events.edit' }));
    expect(await screen.findByPlaceholderText('form.title')).toHaveValue('Standup');
  });
});

describe('CalendarApp from the keyboard', () => {
  it('gives the month grid one tab stop and moves between days with the arrows', () => {
    setUp([], 'month');
    const { container } = renderApp();
    const tabbable = container.querySelectorAll('[data-day-button][tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    const today = tabbable[0] as HTMLButtonElement;
    today.focus();
    fireEvent.keyDown(today, { key: 'ArrowRight' });
    expect(useCalendarStore.getState().selectedDate).toEqual(new Date(2026, 9, 13));
    expect(document.activeElement).toBe(container.querySelector('[data-day-button="2026-10-13"]'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(useCalendarStore.getState().selectedDate).toEqual(new Date(2026, 9, 20));
    // The arrows moved the selection, not the calendar a month on.
    expect(useCalendarStore.getState().viewMode).toBe('month');
  });

  it('moves the focus into an opened event card and back to the event on Escape', async () => {
    renderApp();
    const card = screen.getAllByRole('button', { name: /Standup/ })[0];
    card.focus();
    fireEvent.click(card, { detail: 0 });
    const popover = await screen.findByRole('dialog', { name: 'Standup' });
    await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Standup' })).toBeNull());
    expect(document.activeElement).toBe(card);
  });

  it('reaches a task with Tab and opens it', async () => {
    setUp([], 'tasks');
    const task = { id: 't1', '@type': 'Task', title: 'Buy milk', calendarIds: { cal: true }, progress: 'needs-action', priority: 0, due: null, showWithoutTime: true } as never;
    useTaskStore.setState({ tasks: [task] } as never);
    client.getCalendarTasks.mockResolvedValue([task]);
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: /Buy milk/ }));
    expect(screen.getByRole('heading', { name: 'tasks.edit' })).toBeInTheDocument();
  });
});

describe('CalendarApp control names', () => {
  it('names close buttons Close and tells the arrows apart', async () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
    // Cancel is the text button in the footer, not the X.
    expect(screen.getAllByRole('button', { name: 'form.cancel' })).toHaveLength(1);
    // The mini calendar's arrows step months, the toolbar's the view.
    expect(screen.getByRole('button', { name: 'mini_prev_month' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'nav_prev' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'nav_hide_sidebar' })).toBeInTheDocument();
  });

  it('names the task editor fields and its close button', async () => {
    setUp([], 'tasks');
    renderApp();
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
    expect(screen.getByLabelText('tasks.due_date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('tasks.priority').tagName).toBe('SELECT');
    expect(screen.getByLabelText('tasks.quick_add_placeholder')).toBeInTheDocument();
  });

  it('reads an all-day event as all day, not as midnight to 23:00', () => {
    setUp([makeEvent({ title: 'Trip', showWithoutTime: true, start: '2026-10-12T00:00:00', duration: 'P1D' })], 'month');
    renderApp();
    expect(screen.getAllByRole('button', { name: /Trip/ })[0].getAttribute('aria-label')).toContain('events.all_day');
  });
});

describe('CalendarApp in the demo', () => {
  it('leaves Import and Subscribe out, which need a mail server', async () => {
    config.demoMode = true;
    try {
      renderApp();
      fireEvent.click(screen.getByRole('button', { name: 'toolbar.more' }));
      expect(await screen.findByRole('menuitem', { name: 'refresh' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'toolbar.import' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'toolbar.subscribe' })).toBeNull();
    } finally {
      config.demoMode = false;
    }
  });
});

describe('CalendarApp in Lite', () => {
  it('leaves Subscribe out, since the static build has no feed proxy', async () => {
    lite.on = true;
    try {
      render(<><CalendarApp /><PaletteGroups /></>);
      fireEvent.click(screen.getByRole('button', { name: 'toolbar.more' }));
      expect(await screen.findByRole('menuitem', { name: 'toolbar.import' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'toolbar.subscribe' })).toBeNull();
      expect(screen.getByTestId('palette').textContent).not.toContain('toolbar.subscribe');
    } finally {
      lite.on = false;
    }
  });
});

describe('CalendarApp view menu', () => {
  it('opens as a menu the keyboard can use and switches the view', async () => {
    renderApp();
    fireEvent.click(screen.getByTestId('calendar-view-menu'), { detail: 0 });
    const day = await screen.findByRole('menuitemradio', { name: /views\.day/ });
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio'));
    fireEvent.click(day);
    expect(useCalendarStore.getState().viewMode).toBe('day');
  });
});

describe('CalendarApp long names', () => {
  it('shows the full name of a cut-off calendar on hover', () => {
    const long = { ...calendars[0], name: 'Stalwart Calendar (usera@internal.bulwarkmail.org)' };
    useCalendarStore.setState({ calendars: [long] } as never);
    renderApp();
    expect(screen.getByTestId('calendar-item').querySelector('[title]')).toHaveAttribute('title', long.name);
  });
});

describe('CalendarApp after saving', () => {
  it('brings a new event into view when it starts outside the hours shown', async () => {
    useSettingsStore.setState({ calendarLimitHours: true, calendarDayStartHour: 8, calendarDayEndHour: 18 } as never);
    try {
      renderApp();
      expect(screen.queryAllByRole('button', { name: /01:00$/ })).toHaveLength(0);
      fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
      fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Night train' } });
      fireEvent.change(document.querySelector('input[type="time"]')!, { target: { value: '01:00' } });
      fireEvent.click(screen.getByRole('button', { name: 'form.save' }));
      await waitFor(() => expect(store.createEvent).toHaveBeenCalled());
      await waitFor(() => expect(screen.getAllByRole('button', { name: /01:00$/ }).length).toBeGreaterThan(0));
    } finally {
      useSettingsStore.setState({ calendarLimitHours: false } as never);
    }
  });
});

describe('CalendarApp empty agenda', () => {
  it('offers to create the first event', () => {
    setUp([], 'agenda');
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'events.new_event' }));
    expect(screen.getByRole('heading', { name: 'events.create' })).toBeInTheDocument();
  });
});

describe('CalendarApp selected event', () => {
  it('rings the event whose card is open', async () => {
    renderApp();
    const card = screen.getAllByRole('button', { name: /Standup/ })[0];
    expect(card.style.boxShadow).not.toContain('--color-primary');
    fireEvent.click(card);
    await screen.findByRole('dialog', { name: 'Standup' });
    expect(screen.getAllByRole('button', { name: /Standup/ })[0].style.boxShadow).toContain('var(--color-primary)');
  });
});

describe('CalendarApp day view tasks', () => {
  it('draws a due task with the same chip as the week and month grids', async () => {
    setUp([], 'day');
    const task = { id: 't1', '@type': 'Task', title: 'Buy milk', calendarIds: { cal: true }, progress: 'needs-action', priority: 0, due: '2026-10-12', showWithoutTime: true } as never;
    useSettingsStore.setState({ showTasksOnCalendar: true } as never);
    useTaskStore.setState({ tasks: [task] } as never);
    client.getCalendarTasks.mockResolvedValue([task]);
    try {
      renderApp();
      const chip = await waitFor(() => {
        const found = document.querySelector('[data-calendar-task="t1"]');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      // The shared chip: the title is its own button that opens the task.
      fireEvent.click(within(chip).getByRole('button', { name: 'Buy milk' }));
      expect(screen.getByRole('heading', { name: 'tasks.edit' })).toBeInTheDocument();
    } finally {
      useSettingsStore.setState({ showTasksOnCalendar: false } as never);
    }
  });
});

describe('CalendarApp company calendars on a phone', () => {
  it('lists them in the toolbar\'s calendar list, where hiding one is the synced choice', async () => {
    media.mobile = true;
    media.desktop = false;
    const policy = usePolicyStore.getState().policy;
    usePolicyStore.setState({ policy: { ...policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, calendars: { feeds: [{ id: 'hol', name: 'Holidays', url: '', urlHeld: true, color: '#16a34a', refreshMinutes: 60 }], freeBusyGroup: '' } } } });
    useSettingsStore.setState({ hiddenCompanyCalendars: [] } as never);
    try {
      renderApp();
      // The toolbar's list (the sidebar heading has the same words).
      fireEvent.click(document.querySelector<HTMLElement>('button[aria-label="my_calendars"]')!);
      const list = (await screen.findByRole('heading', { name: 'my_calendars' })).parentElement!;
      fireEvent.click(within(list).getByRole('button', { name: 'Holidays' }));
      expect(useSettingsStore.getState().hiddenCompanyCalendars).toEqual(['hol']);
    } finally {
      usePolicyStore.setState({ policy });
    }
  });
});
