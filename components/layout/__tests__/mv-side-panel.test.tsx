import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { MvSidePanel } from '../mv-side-panel';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';

describe('MvSidePanel', () => {
  beforeEach(() => {
    useCalendarStore.setState({ supportsCalendar: true, calendars: [], events: [] } as never);
    useSettingsStore.setState({ enableCalendarTasks: false } as never);
  });

  it('offers only the apps that are there, and opens and closes their panel', () => {
    const { container } = render(<MvSidePanel />);
    expect(screen.getByRole('button', { name: 'calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mv_tasks' })).toBeNull();
    expect(container.querySelector('[data-mv-side-panel]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'calendar' }));
    expect(container.querySelector('[data-mv-side-panel="calendar"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'calendar' }));
    expect(container.querySelector('[data-mv-side-panel]')).toBeNull();
  });

  it('adds Tasks when tasks are turned on', () => {
    useSettingsStore.setState({ enableCalendarTasks: true } as never);
    render(<MvSidePanel />);
    expect(screen.getByRole('button', { name: 'mv_tasks' })).toBeInTheDocument();
  });

  it('leaves the apps out with pluginsOnly', () => {
    useSettingsStore.setState({ enableCalendarTasks: true } as never);
    const { container } = render(<MvSidePanel pluginsOnly />);
    expect(screen.queryByRole('button', { name: 'calendar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'mv_tasks' })).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('draws nothing without any app to show', () => {
    useCalendarStore.setState({ supportsCalendar: false } as never);
    const { container } = render(<MvSidePanel />);
    expect(container.firstChild).toBeNull();
  });
});
