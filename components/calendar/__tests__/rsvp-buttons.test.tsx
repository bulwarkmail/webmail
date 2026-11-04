import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ParticipantStatusBadge, RsvpButtons } from '../rsvp-buttons';

// "Tentative" (#eab308) and "Accepted" (#22c55e) text on white measured
// about 1.9:1 and 2.3:1, and the chosen Tentative was white on yellow. Text
// uses the darker status shades; a chosen answer gets dark text.

describe('participation status colours', () => {
  it('writes answers in readable status shades, not the light fills', () => {
    render(<RsvpButtons status={null} onRespond={vi.fn()} />);
    const maybe = screen.getByRole('button', { name: 'participants.maybe' });
    expect(maybe.className).toContain('text-amber-600');
    expect(maybe.className).not.toMatch(/\btext-warning\b/);
    expect(screen.getByRole('button', { name: 'participants.accept' }).className).toContain('text-green-700');
  });

  it('puts dark text on the chosen yellow answer', () => {
    render(<RsvpButtons status="tentative" onRespond={vi.fn()} />);
    const maybe = screen.getByRole('button', { name: 'participants.maybe' });
    expect(maybe).toHaveAttribute('aria-pressed', 'true');
    expect(maybe.className).toContain('text-neutral-950');
    expect(maybe.className).not.toContain('text-warning-foreground');
  });

  it('labels the buttons with what they do, not the state', () => {
    render(<RsvpButtons status={null} onRespond={vi.fn()} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['participants.accept', 'participants.maybe', 'participants.decline']);
  });

  it('colours a participant\'s answer the same way', () => {
    render(<ParticipantStatusBadge status="accepted" />);
    // In plain words (pim-19): ux_pim_event.status_accepted.
    expect(screen.getByText('status_accepted').className).toContain('text-green-700');
  });
});
