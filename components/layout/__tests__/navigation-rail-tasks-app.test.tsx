import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1698: with Settings > Calendar > Tasks as their own app, Tasks get an
// entry of their own in the rail, after the calendar, marked on /tasks.

let pathname = '/tasks';
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => pathname,
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { NavigationRail } = await import('../navigation-rail');
const { useUpdateStore } = await import('@/stores/update-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useCalendarStore } = await import('@/stores/calendar-store');
const { usePolicyStore } = await import('@/stores/policy-store');

const tasksLink = () => document.querySelector('a[href="/tasks"]');

beforeEach(() => {
  pathname = '/tasks';
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
  useCalendarStore.setState({ supportsCalendar: true });
  useSettingsStore.setState({ enableCalendarTasks: true, showTasksApp: true });
  usePolicyStore.setState({ isFeatureEnabled: () => true } as never);
});

describe.each([
  ['rail', { orientation: 'vertical', collapsed: true }],
  ['bottom bar', { orientation: 'horizontal', collapsed: false }],
] as const)('%s', (_name, props) => {
  it('has no Tasks entry while the option is off', () => {
    useSettingsStore.setState({ showTasksApp: false });
    render(<NavigationRail {...props} />);
    expect(tasksLink()).toBeNull();
  });

  it('lists Tasks right after Calendar, marked on the Tasks page', () => {
    render(<NavigationRail {...props} />);
    const hrefs = Array.from(document.querySelectorAll('a[data-tour^="nav-"]')).map((a) => a.getAttribute('href'));
    expect(hrefs.indexOf('/tasks')).toBe(hrefs.indexOf('/calendar') + 1);
    expect(tasksLink()?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('a[href="/calendar"]')?.getAttribute('aria-current')).toBeNull();
  });

  it('drops the entry when tasks are turned off, by the user or the admin', () => {
    useSettingsStore.setState({ enableCalendarTasks: false });
    const { unmount } = render(<NavigationRail {...props} />);
    expect(tasksLink()).toBeNull();
    unmount();
    useSettingsStore.setState({ enableCalendarTasks: true });
    usePolicyStore.setState({ isFeatureEnabled: (f: string) => f !== 'calendarTasksEnabled' } as never);
    render(<NavigationRail {...props} />);
    expect(tasksLink()).toBeNull();
  });
});

it('names the entry from the sidebar strings', () => {
  render(<NavigationRail orientation="vertical" collapsed />);
  expect(screen.getByRole('link', { name: 'tasks' })).toBeTruthy();
});
