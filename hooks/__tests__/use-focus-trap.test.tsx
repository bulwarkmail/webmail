import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { useFocusTrap } from '../use-focus-trap';

function Dialog({ onEscape, note }: { onEscape: () => void; note?: string }) {
  const ref = useFocusTrap({ isActive: true, onEscape });
  return (
    <div ref={ref} role="dialog">
      <button type="button">close</button>
      <input aria-label="name" />
      {note && <p>{note}</p>}
    </div>
  );
}

function Page({ open, onEscape, note }: { open: boolean; onEscape: () => void; note?: string }) {
  return (
    <>
      <button type="button">opener</button>
      {open && <Dialog onEscape={onEscape} note={note} />}
    </>
  );
}

// Like the identity and template managers: a list that gives way to a form,
// taking the button that had the focus with it.
function Manager() {
  const [editing, setEditing] = useState(false);
  const ref = useFocusTrap({ isActive: true, onEscape: () => setEditing(false) });
  return (
    <div ref={ref} role="dialog">
      <button type="button">close</button>
      {editing
        ? <input aria-label="field" />
        : <button type="button" onClick={() => setEditing(true)}>edit</button>}
    </div>
  );
}

describe('useFocusTrap', () => {
  it('moves the focus in when it opens and back to the opener when it closes', () => {
    const { rerender } = render(<Page open={false} onEscape={() => {}} />);
    screen.getByText('opener').focus();
    rerender(<Page open onEscape={() => {}} />);
    expect(document.activeElement).toBe(screen.getByText('close'));
    rerender(<Page open={false} onEscape={() => {}} />);
    expect(document.activeElement).toBe(screen.getByText('opener'));
  });

  it('leaves the focus in the field while the page behind renders again', () => {
    // A background request renders the page again, and the dialog gets a
    // new onEscape: the field the user is typing in keeps the focus.
    const { rerender } = render(<Page open onEscape={() => {}} />);
    const field = screen.getByLabelText('name');
    field.focus();
    rerender(<Page open onEscape={() => {}} />);
    rerender(<Page open onEscape={() => {}} />);
    expect(document.activeElement).toBe(field);
  });

  it('answers Escape with the onEscape of the latest render', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<Page open onEscape={first} />);
    rerender(<Page open onEscape={latest} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('keeps the focus in the dialog when a view change removes the element that had it', async () => {
    render(<Manager />);
    const edit = screen.getByText('edit');
    edit.focus();
    fireEvent.click(edit);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('close')));
  });

  it('leaves a focus the user moved away alone when the dialog changes', async () => {
    const { rerender } = render(<Page open onEscape={() => {}} />);
    const field = screen.getByLabelText('name');
    field.focus();
    field.blur();
    rerender(<Page open onEscape={() => {}} note="saved" />);
    await screen.findByText('saved');
    await Promise.resolve();
    expect(document.activeElement).toBe(document.body);
  });
});
