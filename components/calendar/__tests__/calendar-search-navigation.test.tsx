import {createRef, useState} from 'react';
import {render, screen, fireEvent, within} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {CalendarSearchField, CalendarSearchResults} from '../calendar-search';
import type {CalendarEvent} from '@/lib/jmap/types';
const event = (id:string,title:string): CalendarEvent => ({
  id, uid:id, title, '@type':'Event', calendarIds:{work:true},
  start:'2030-11-03T10:00:00', duration:'PT1H', timeZone:null,
  isDraft:false, isOrigin:true, utcStart:null, utcEnd:null,
  description:'', descriptionContentType:'text/plain', created:null,
  updated:'2030-11-03T09:00:00Z', sequence:0, showWithoutTime:false,
  status:'confirmed', freeBusyStatus:'busy', privacy:'public', color:null,
  keywords:null, categories:null, locale:null, replyTo:null,
  organizerCalendarAddress:null, participants:null, mayInviteSelf:false,
  mayInviteOthers:false, hideAttendees:false, recurrenceId:null,
  recurrenceIdTimeZone:null, recurrenceRules:null, recurrenceOverrides:null,
  excludedRecurrenceRules:null, useDefaultAlerts:false, alerts:null,
  locations:null, virtualLocations:null, links:null, relatedTo:null,
});
const first = event('one','Planning with the product team');
const second = event('two','Design review');
const past = event('past','Previous workshop');
function Pane({name,events=[first,second],onSelect=vi.fn()}:{name:string;events?:CalendarEvent[];onSelect?:(event:CalendarEvent,rect:DOMRect)=>void}) {
  const [query,setQuery]=useState('planning');
  return <section aria-label={name} data-calendar-search-scope="">
    <CalendarSearchField value={query} onChange={setQuery}/>
    <CalendarSearchResults query={query} results={{upcoming:events,past:[past],searching:false}} calendars={[]} onSelectEvent={onSelect}/>
  </section>;
}

describe('calendar search navigation',()=>{
  it('keeps Down and return-to-search inside the current pane',()=>{
    const onSelect=vi.fn();
    render(<><Pane name="First pane"/><Pane name="Second pane" onSelect={onSelect}/></>);
    const pane=within(screen.getByRole('region',{name:'Second pane'}));
    const field=pane.getByRole('searchbox');
    fireEvent.keyDown(field,{key:'ArrowDown'});
    const row=pane.getByRole('button',{name:/Planning with/});
    expect(row).toHaveFocus();
    fireEvent.keyDown(row,{key:'ArrowUp'});
    expect(field).toHaveFocus();
    fireEvent.keyDown(field,{key:'ArrowDown'});
    fireEvent.keyDown(row,{key:'End'});
    const last=pane.getByRole('button',{name:/Previous workshop/});
    expect(last).toHaveFocus();
    fireEvent.keyDown(last,{key:'Home'});
    expect(row).toHaveFocus();
    fireEvent.keyDown(row,{key:'Escape'});
    expect(field).toHaveFocus();
    expect(field).toHaveValue('planning');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('gives simultaneous result sections unique linked headings',()=>{
    render(<><Pane name="First pane"/><Pane name="Second pane"/></>);
    const headings=screen.getAllByRole('heading');
    expect(new Set(headings.map(heading=>heading.id)).size).toBe(headings.length);
    for(const heading of headings) expect(heading.parentElement).toHaveAttribute('aria-labelledby',heading.id);
  });

  it('keeps search focus after clear and after Escape without a dismissal handler',()=>{
    render(<Pane name="Search pane"/>);
    const field=screen.getByRole('searchbox');
    fireEvent.click(screen.getByRole('button',{name:'search.clear'}));
    expect(field).toHaveFocus();expect(field).toHaveValue('');
    fireEvent.keyDown(field,{key:'Escape'});
    expect(field).toHaveFocus();
  });

  it('keeps modified and composition keys out of result navigation',()=>{
    render(<Pane name="Search pane"/>);
    const field=screen.getByRole('searchbox');field.focus();
    fireEvent.keyDown(field,{key:'ArrowDown',isComposing:true});
    fireEvent.keyDown(field,{key:'ArrowDown',ctrlKey:true});
    expect(field).toHaveFocus();
    const row=screen.getByRole('button',{name:/Design review/});row.focus();
    fireEvent.keyDown(row,{key:'Escape',isComposing:true});
    fireEvent.keyDown(row,{key:'Home',shiftKey:true});
    expect(row).toHaveFocus();
  });

  it('preserves event selection/context callbacks and semantic timestamps',()=>{
    const onSelect=vi.fn();const onContext=vi.fn();
    const {container}=render(<div data-calendar-search-scope=""><CalendarSearchResults query="plan" calendars={[]}
      results={{upcoming:[first],past:[],searching:false}} onSelectEvent={onSelect} onContextMenuEvent={onContext}/></div>);
    const row=screen.getByRole('button',{name:/Planning with/});
    fireEvent.click(row);expect(onSelect).toHaveBeenCalledWith(first,expect.any(Object));
    fireEvent.contextMenu(row);expect(onContext).toHaveBeenCalledWith(expect.any(Object),first);
    expect(container.querySelector('time')).toHaveAttribute('datetime',first.start);
  });

  it('keeps forwarded refs and uses the explicit empty-field dismissal',()=>{
    const ref=createRef<HTMLInputElement>();const onDismiss=vi.fn();
    render(<CalendarSearchField ref={ref} value="" onChange={vi.fn()} onDismiss={onDismiss}/>);
    expect(ref.current).toBe(screen.getByRole('searchbox'));
    fireEvent.keyDown(ref.current!,{key:'Escape'});
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('returns empty-result recovery to the current pane search',()=>{
    const onClear=vi.fn();
    render(<><Pane name="Other pane"/><section aria-label="Empty pane" data-calendar-search-scope="">
      <CalendarSearchField value="missing" onChange={vi.fn()}/>
      <CalendarSearchResults query="missing" calendars={[]} results={{upcoming:[],past:[],searching:false}}
        onSelectEvent={vi.fn()} onClearSearch={onClear}/>
    </section></>);
    const pane=within(screen.getByRole('region',{name:'Empty pane'}));
    fireEvent.click(within(pane.getByTestId('calendar-search-results')).getByRole('button',{name:'search.clear'}));
    expect(onClear).toHaveBeenCalledOnce();
    expect(pane.getByRole('searchbox')).toHaveFocus();
  });

  it('announces an in-progress result refresh without hiding loaded rows',()=>{
    render(<CalendarSearchResults query="plan" calendars={[]} results={{upcoming:[first],past:[],searching:true}} onSelectEvent={vi.fn()}/>);
    expect(screen.getByTestId('calendar-search-results')).toHaveAttribute('aria-busy','true');
    expect(screen.getByRole('button',{name:/Planning with/})).toBeInTheDocument();
  });
});
