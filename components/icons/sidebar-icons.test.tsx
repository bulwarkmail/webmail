import {createRef} from 'react';
import {render, screen} from '@testing-library/react';
import {expect, it} from 'vitest';
import {Inbox, Folder, Mail, Settings} from './sidebar-icons';

it('uses Heroicons outlines while preserving size, stroke, SVG props and refs', () => {
  const ref=createRef<SVGSVGElement>();
  render(<Inbox ref={ref} size={20} stroke={2} data-testid="inbox-icon" />);
  expect(ref.current).toBe(screen.getByTestId('inbox-icon'));
  expect(ref.current).toHaveAttribute('data-memail-icon-set','heroicons');
  expect(ref.current).toHaveAttribute('viewBox','0 0 24 24');
  expect(ref.current).toHaveAttribute('width','20');
  expect(ref.current).toHaveAttribute('stroke-width','2');
  expect(ref.current).toHaveAttribute('fill','none');
});

it('keeps decorative icons hidden while allowing a named graphic', () => {
  const {container}=render(<><Folder/><Mail aria-label="Mail graphic"/><Settings/></>);
  const icons=container.querySelectorAll('svg');
  expect(icons[0]).toHaveAttribute('aria-hidden','true');
  expect(icons[1]).not.toHaveAttribute('aria-hidden');
  expect(icons[1]).toHaveAttribute('aria-label','Mail graphic');
  expect(icons[2]).toHaveAttribute('data-memail-icon','Settings');
});
