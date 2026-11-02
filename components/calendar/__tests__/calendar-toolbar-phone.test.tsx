import {useState} from 'react';
import type {Calendar} from '@/lib/jmap/types';
import type {CalendarViewMode} from '@/stores/calendar-store';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CalendarToolbar } from '../calendar-toolbar';

// The phone day view's title was cut to "Th…": the long date beside the
// menu, the back arrow, both chevrons, Today and the header buttons.

vi.mock('@/components/layout/phone-header-actions', () => ({ PhoneHeaderActions: () => null }));

function renderToolbar(overrides: Partial<React.ComponentProps<typeof CalendarToolbar>> = {}) {
  render(
    <CalendarToolbar
      selectedDate={new Date(2026, 9, 28)}
      viewMode="day"
      onPrev={vi.fn()}
      onNext={vi.fn()}
      onToday={vi.fn()}
      onViewModeChange={vi.fn()}
      onCreateEvent={vi.fn()}
      isMobile
      onMenuClick={vi.fn()}
      {...overrides}
    />,
  );
}

describe('phone toolbar in the day view', () => {
  it('names the day short, with the full date as its tooltip', () => {
    renderToolbar();
    const title = screen.getByText('Oct 28');
    expect(title).toHaveAttribute('title', 'Wednesday, October 28, 2026');
  });

  it('puts the way back to the month in the menu button\'s place', () => {
    renderToolbar({ onNavigateBack: vi.fn() });
    expect(screen.getByRole('button', { name: 'back_to_month' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'nav_open_menu' })).toBeNull();
  });

  it('keeps the menu when there is no way back', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: 'nav_open_menu' })).toBeInTheDocument();
  });
});

// At 320px the month title was cut to one letter ("C…") beside the menu, the
// chevrons, Today and the header buttons.
describe('phone toolbar at 320px', () => {
  it('keeps the compact period in a named heading beside the shell actions', () => {
    renderToolbar({ viewMode: 'month' });
    const title = screen.getByRole('heading', {name:'Oct 2026'});
    expect(title).toHaveAttribute('title','Oct 2026');
  });
});


describe('calendar navigation controls', () => {
  it('uses one view Tab stop with RTL-aware arrow and boundary navigation', () => {
    const onViewModeChange = vi.fn();
    function Host() {
      const [view, setView] = useState<CalendarViewMode>('month');
      return <CalendarToolbar selectedDate={new Date(2026, 9, 28)} viewMode={view} isMobile enableCalendarTasks
        onViewModeChange={value => {setView(value);onViewModeChange(value);}}
        onPrev={vi.fn()} onNext={vi.fn()} onToday={vi.fn()} onCreateEvent={vi.fn()}/>;
    }
    render(<Host/>);
    const month = screen.getByRole('radio', {name:'views.month'});
    const week = screen.getByRole('radio', {name:'views.week'});
    expect(month).toHaveAttribute('tabindex','0');
    expect(week).toHaveAttribute('tabindex','-1');
    fireEvent.keyDown(month,{key:'ArrowRight'});
    expect(week).toHaveFocus();
    expect(week).toHaveAttribute('aria-checked','true');
    fireEvent.keyDown(week,{key:'End'});
    const tasks = screen.getByRole('radio', {name:'views.tasks'});
    expect(tasks).toHaveFocus();
    expect(screen.queryByRole('button',{name:'nav_prev'})).toBeNull();
    fireEvent.keyDown(tasks,{key:'Home'});
    expect(month).toHaveFocus();
    screen.getByRole('radiogroup').style.direction = 'rtl';
    fireEvent.keyDown(month,{key:'ArrowLeft'});
    expect(week).toHaveFocus();
    expect(onViewModeChange).toHaveBeenLastCalledWith('week');
    fireEvent.keyDown(week,{key:'ArrowRight',ctrlKey:true});
    expect(onViewModeChange).toHaveBeenCalledTimes(4);
  });

  it('keeps tasks out of the switcher when disabled', () => {
    renderToolbar({viewMode:'month'});
    expect(screen.queryByRole('radio',{name:'views.tasks'})).toBeNull();
  });

  it('exposes calendar checked state, retains shared context and returns focus after Escape', async () => {
    const onToggle = vi.fn();
    const calendars = [
      {id:'work',name:'Work',color:'#2563eb'},
      {id:'shared',name:'Team schedule',color:'#16a34a',isShared:true,accountId:'team',accountName:'Team account'},
    ] as Calendar[];
    function Host() {
      const [visible,setVisible] = useState(['work']);
      return <CalendarToolbar selectedDate={new Date(2026,9,28)} viewMode="month" isMobile
        onPrev={vi.fn()} onNext={vi.fn()} onToday={vi.fn()} onCreateEvent={vi.fn()} onViewModeChange={vi.fn()}
        calendars={calendars} selectedCalendarIds={visible}
        onToggleVisibility={id => {onToggle(id);setVisible(value => value.includes(id) ? value.filter(item=>item!==id) : [...value,id]);}}/>;
    }
    render(<Host/>);
    const trigger = screen.getByRole('button',{name:'my_calendars'});
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu',{name:'my_calendars'});
    const work = within(menu).getByRole('menuitemcheckbox',{name:'Work'});
    await waitFor(()=>expect(work).toHaveFocus());
    expect(work).toHaveAttribute('aria-checked','true');
    expect(within(menu).getByText('Team account')).toBeInTheDocument();
    fireEvent.keyDown(work,{key:'ArrowDown'});
    const shared = within(menu).getByRole('menuitemcheckbox',{name:'Team schedule'});
    expect(shared).toHaveFocus();
    expect(shared).toHaveAttribute('aria-checked','false');
    fireEvent.click(shared);
    expect(shared).toHaveAttribute('aria-checked','true');
    expect(onToggle).toHaveBeenCalledWith('shared');
    expect(menu).toBeInTheDocument();
    fireEvent.keyDown(shared,{key:'Escape'});
    await waitFor(()=>expect(trigger).toHaveFocus());
    expect(screen.queryByRole('menu',{name:'my_calendars'})).toBeNull();
  });

  it('uses visible dates for the heading without changing previous/next callbacks', () => {
    const onPrev = vi.fn();const onNext = vi.fn();
    renderToolbar({viewMode:'month',visibleDate:new Date(2026,10,1),onPrev,onNext});
    expect(screen.getByText('Nov 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'nav_prev'}));
    fireEvent.click(screen.getByRole('button',{name:'nav_next'}));
    expect(onPrev).toHaveBeenCalledOnce();expect(onNext).toHaveBeenCalledOnce();
  });
});
