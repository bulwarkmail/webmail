import { describe, expect, it } from 'vitest';
import { extractText } from '@/lib/attachment-text';

// HTML and calendar files: reading takes time in step with the file, and an
// event is described by its own properties only.

const text = (s: string) => new TextEncoder().encode(s);

describe('HTML', () => {
  it('reads an HTML file full of unclosed tags in a moment', async () => {
    // 400 KB of "<head": a regular expression over the source took 8.6 s for this.
    const started = performance.now();
    const out = await extractText(text(`<p>Agenda</p>${'<head'.repeat(80_000)}`), { name: 'odd.html' });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(out.status).toBe('ok');
  }, 20_000);

  it('reads a long numbered list in a moment', async () => {
    const started = performance.now();
    // Numbering each item by searching the list made 20,000 items take far longer than this.
    const out = await extractText(text(`<ol>${'<li>item</li>'.repeat(20_000)}</ol>`), { name: 'list.html', maxChars: 1_000 });
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(out.text.startsWith('item')).toBe(true);
  }, 20_000);

  it('leaves out scripts, styles, templates and the head', async () => {
    const out = await extractText(text('<html><head><title>T</title><style>p{}</style></head><body><p>Body</p><script>alert(1)</script><noscript>ns</noscript><template>tpl</template></body></html>'), { name: 'a.html' });
    expect(out.text).toBe('Body');
  });

  it('reads at most 5 million characters of HTML, and says so', async () => {
    // Little text, a lot of source: only the cap can make this truncated.
    const out = await extractText(text(`<p>Body</p><!--${'x'.repeat(5_100_000)}-->`), { name: 'huge.html' });
    expect(out).toMatchObject({ status: 'ok', text: 'Body', truncated: true });
  });
});

describe('calendar files', () => {
  it('ignores what an alarm inside an event says', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Dentist', 'DTSTART:20261105T090000Z',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'LOCATION:Nowhere', 'END:VALARM',
      'LOCATION:Main street 1', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    expect((await extractText(text(ics), { name: 'a.ics' })).text).toBe('event: Dentist, 2026-11-05 09:00 UTC, Main street 1');
  });
});
