import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MessageTimestamp } from './message-timestamp';

it('keeps the compact date while exposing the precise date and chosen clock format', () => {
  const { rerender } = render(<MessageTimestamp value="2026-11-02T15:42:00+05:00" timeFormat="24h">Today</MessageTimestamp>);
  const date = screen.getByText('Today');
  expect(date.tagName).toBe('TIME');
  expect(date).toHaveAttribute('datetime', '2026-11-02T10:42:00.000Z');
  expect(date.title).toContain('November 2, 2026');
  expect(date.title).toContain('10:42');
  expect(date.title).toContain('UTC');
  rerender(<MessageTimestamp value="2026-11-02T15:42:00+05:00" timeFormat="12h">Today</MessageTimestamp>);
  expect(date.title).toContain('AM');
});

it('leaves an invalid source date without a misleading timestamp', () => {
  render(<MessageTimestamp value="unknown" timeFormat="24h">Unknown date</MessageTimestamp>);
  expect(screen.getByText('Unknown date')).not.toHaveAttribute('datetime');
  expect(screen.getByText('Unknown date')).not.toHaveAttribute('title');
});
