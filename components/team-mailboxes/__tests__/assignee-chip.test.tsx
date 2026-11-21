import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TeamPerson } from '@/lib/team-mailboxes/names';
import { AssigneeChip, DoneMark, type ChipPeople } from '../assignee-chip';

// The strings with their values, so the names and counts can be checked.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : key,
}));

const known: Record<string, TeamPerson> = {
  ca: { id: 'ca', name: 'Alice Archer', email: 'alice@example.org' },
  cj: { id: 'cj', name: 'Josh Jones', email: 'josh@example.org' },
  zz: { id: 'zz', name: '', email: '' },
};
const people = (lookUp = vi.fn()): ChipPeople & { lookUp: ReturnType<typeof vi.fn> } => ({
  selfId: 'ca',
  byId: (id) => (id ? known[id] ?? null : null),
  lookUp,
});

const chip = () => screen.getByTestId('team-assignee-chip');
/** The visible label (the sentence is there for screen readers too). */
const label = () => chip().querySelector('span[aria-hidden="true"]')?.textContent;

describe('the assignee chip', () => {
  it('says Me for the user, with the sentence as title and for screen readers', () => {
    render(<AssigneeChip keywords={{ '$assigned:ca': true }} people={people()} />);
    expect(chip()).toHaveAttribute('title', 'assigned_to_you');
    expect(label()).toBe('chip_me');
    expect(screen.getByText('assigned_to_you')).toHaveClass('sr-only');
  });

  it('shows the first name of someone else', () => {
    render(<AssigneeChip keywords={{ '$assigned:cj': true }} people={people()} />);
    expect(label()).toBe('Josh');
    expect(chip()).toHaveAttribute('title', 'assigned_to(name=Josh Jones)');
  });

  it('says Assigned for someone whose name isn\'t known, and asks for it', () => {
    const lookUp = vi.fn();
    render(<AssigneeChip keywords={{ '$assigned:zz': true }} people={people(lookUp)} />);
    expect(label()).toBe('chip_assigned');
    expect(chip()).toHaveAttribute('title', 'assigned_unknown');
    expect(lookUp).toHaveBeenCalledWith(['zz']);
  });

  it('puts the user first and counts the others when several have it', () => {
    render(<AssigneeChip keywords={{ '$assigned:cj': true, '$assigned:ca': true }} people={people()} />);
    expect(label()).toBe('chip_more(name=chip_me,count=1)');
    expect(chip()).toHaveAttribute('title', 'assigned_to(name=Alice Archer, Josh Jones)');
  });

  it('shows nothing when the message isn\'t assigned', () => {
    const { container } = render(<AssigneeChip keywords={{ $seen: true }} people={people()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('doesn\'t ask for names it knows', () => {
    const lookUp = vi.fn();
    render(<AssigneeChip keywords={{ '$assigned:cj': true }} people={people(lookUp)} />);
    expect(lookUp).not.toHaveBeenCalled();
  });
});

describe('the Done mark', () => {
  it('says Done, with Marked done as title and for screen readers, in the success colour', () => {
    render(<DoneMark keywords={{ $done: true }} />);
    const mark = screen.getByTestId('team-done-mark');
    expect(mark.querySelector('span[aria-hidden="true"]')?.textContent).toBe('done');
    expect(mark).toHaveAttribute('title', 'marked_done');
    expect(screen.getByText('marked_done')).toHaveClass('sr-only');
    expect(mark.className).toMatch(/text-green-700/);
  });

  it('shows nothing on an open message', () => {
    const { container } = render(<DoneMark keywords={{ '$assigned:ca': true }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
