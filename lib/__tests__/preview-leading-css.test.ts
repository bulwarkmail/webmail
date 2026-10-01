import { describe, expect, it } from 'vitest';
import { cleanPreview, stripLeadingCss } from '@/lib/utils';

// Some servers build a message preview from its HTML without skipping the
// <style> element, so a marketing mail's preview starts with its style sheet.
describe('stripLeadingCss', () => {
  it('drops a leading media query and keeps the text after it', () => {
    const preview = '@media screen and (min-width:600px){.hide{display:none!important;overflow:hidden!important}.show{display:block!important}} Your parcel is on its way';
    expect(stripLeadingCss(preview)).toBe('Your parcel is on its way');
  });

  it('drops several leading rules in a row', () => {
    expect(stripLeadingCss('.a{color:red} #b p{margin:0} td, th {padding:0}Hello')).toBe('Hello');
  });

  it('drops a leading @import that ends without a block', () => {
    expect(stripLeadingCss("@import url('x.css'); Weekly digest")).toBe('Weekly digest');
  });

  it('empties a preview that ends inside the style sheet', () => {
    expect(stripLeadingCss('@media screen and (min-width:600px){.hide{display:none!important;max-height:0!import')).toBe('');
  });

  it('leaves ordinary text alone, braces and all', () => {
    for (const text of [
      'Hi Luca, the meeting is at {time} tomorrow',
      '#1234 has been shipped',
      '@Luca can you check the figures?',
      'Order {A-17} confirmed',
      'Price {EUR}: 10 per box',
      'Meeting at {room',
      '@media team, the brief is attached',
      '@Page can you check?',
      '@import the CSV, then send it back',
      'Reminder: your appointment {date: 2026-10-01} is confirmed',
    ]) expect(stripLeadingCss(text)).toBe(text);
  });
});

describe('cleanPreview', () => {
  it('strips padding and a style sheet together, and treats nothing left as no preview', () => {
    expect(cleanPreview('\u034f \u200b.x{color:red} Real text')).toBe('Real text');
    expect(cleanPreview('.x{color:red} ...')).toBe('');
    expect(cleanPreview(null)).toBe('');
  });
});

describe('stripLeadingCss pseudo-classes', () => {
  it('still drops a rule whose selector has a pseudo-class', () => {
    expect(stripLeadingCss('a:hover, a:focus{color:red} Hello')).toBe('Hello');
  });
});
