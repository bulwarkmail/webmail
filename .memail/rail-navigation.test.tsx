import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { navigateRail } from './rail-navigation';

it('moves through usable rail actions without activating them', () => {
  const activate = vi.fn();
  render(<nav onKeyDown={e=>navigateRail(e)}><a href="/mail" onClick={activate}>Mail</a><button disabled>Unavailable</button><button hidden>Hidden</button><button onClick={activate}>Apps</button></nav>);
  screen.getByRole('link').focus();
  fireEvent.keyDown(screen.getByRole('link'), {key:'ArrowDown'});
  expect(screen.getByRole('button',{name:'Apps'})).toHaveFocus();
  expect(activate).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button',{name:'Apps'}), {key:'ArrowDown'});
  expect(screen.getByRole('link')).toHaveFocus();
});

it('respects RTL horizontal navigation and leaves Tab and modified keys alone', () => {
  render(<nav style={{direction:'rtl'}} onKeyDown={e=>navigateRail(e,true)}><button>Mail</button><button>Calendar</button></nav>);
  const mail=screen.getByRole('button',{name:'Mail'});mail.focus();
  fireEvent.keyDown(mail,{key:'ArrowLeft'});
  expect(screen.getByRole('button',{name:'Calendar'})).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('button',{name:'Calendar'}),{key:'Home'});
  expect(mail).toHaveFocus();
  expect(fireEvent.keyDown(mail,{key:'Tab'})).toBe(true);
  expect(fireEvent.keyDown(mail,{key:'ArrowLeft',ctrlKey:true})).toBe(true);
  expect(mail).toHaveFocus();
});
