import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHandoffFiles } from '../use-handoff-files';
import { handOffFiles, takeHandoff } from '@/lib/launch-handoff';
import { mergeCalendarTexts, mergeVCardTexts } from '@/lib/file-drop/merge-imports';

// pim-p2-10: several .ics or .vcf dropped together go into one import list.

const ics = (uid: string, title: string) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
  'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, 'DTSTART:20261110T090000Z', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');
const vcf = (name: string) => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, 'END:VCARD', ''].join('\r\n');

afterEach(() => {
  for (const kind of ['calendar', 'contacts'] as const) while (takeHandoff(kind)) { /* drain */ }
});

describe('merging calendars and cards', () => {
  it('puts every event of two calendars into one VCALENDAR', () => {
    const merged = mergeCalendarTexts([ics('a', 'First'), ics('b', 'Second')]);
    expect(merged.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(merged.match(/END:VCALENDAR/g)).toHaveLength(1);
    expect(merged.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(merged).toContain('SUMMARY:First');
    expect(merged).toContain('SUMMARY:Second');
    expect(merged.match(/VERSION:2.0/g)).toHaveLength(1);
  });

  it('puts the cards one after the other', () => {
    const merged = mergeVCardTexts([vcf('Anna'), vcf('Ben')]);
    expect(merged.match(/BEGIN:VCARD/g)).toHaveLength(2);
  });
});

describe('useHandoffFiles', () => {
  it('gives two dropped .ics as one file to the import', async () => {
    const { result } = renderHook(() => useHandoffFiles('calendar', true));
    act(() => {
      handOffFiles([
        new File([ics('a', 'First')], 'first.ics', { type: 'text/calendar' }),
        new File([ics('b', 'Second')], 'second.ics', { type: 'text/calendar' }),
      ], 'calendar');
    });
    await waitFor(() => expect(result.current.file).not.toBeNull());
    const text = await result.current.file!.text();
    expect(text).toContain('SUMMARY:First');
    expect(text).toContain('SUMMARY:Second');
    act(() => result.current.done());
    expect(result.current.file).toBeNull();
  });

  it('gives three .vcf as one file', async () => {
    const { result } = renderHook(() => useHandoffFiles('contacts', true));
    act(() => {
      handOffFiles(['Anna', 'Ben', 'Cleo'].map((n) => new File([vcf(n)], `${n}.vcf`, { type: 'text/vcard' })), 'contacts');
    });
    await waitFor(() => expect(result.current.file).not.toBeNull());
    expect((await result.current.file!.text()).match(/BEGIN:VCARD/g)).toHaveLength(3);
    act(() => result.current.done());
    expect(result.current.file).toBeNull();
  });
});
