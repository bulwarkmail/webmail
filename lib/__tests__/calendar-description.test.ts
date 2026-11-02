import { describe, expect, it } from 'vitest';
import { descriptionWithNote } from '@/lib/calendar-description';

// The quick note in the event popover is added to the description.

describe('descriptionWithNote', () => {
  it('adds a note to an HTML description as an HTML paragraph', () => {
    const fields = descriptionWithNote(
      { description: '<p><b>Agenda</b></p>', descriptionContentType: 'text/html' },
      '--- 2026-11-02 10:00 ---',
      'Call <Bob> & Ann\nabout it',
    );
    expect(fields).toEqual({
      description: '<p><b>Agenda</b></p><p>--- 2026-11-02 10:00 ---<br>Call &lt;Bob&gt; &amp; Ann<br>about it</p>',
    });
  });

  it('adds a note to a plain description as text', () => {
    expect(descriptionWithNote({ description: 'Agenda', descriptionContentType: 'text/plain' }, '--- t ---', 'Call Bob'))
      .toEqual({ description: 'Agenda\n\n--- t ---\nCall Bob' });
    expect(descriptionWithNote({ description: '' }, '--- t ---', 'Call Bob'))
      .toEqual({ description: '--- t ---\nCall Bob' });
  });
});
