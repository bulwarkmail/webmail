import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// "Not sent - the server rejected every recipient." read as a hyphen where a colon belongs
// (usability pass 2, desktop-p2-18).
const LOCALES = join(process.cwd(), 'locales');

describe('the send error for refused recipients', () => {
  it.each(readdirSync(LOCALES))('%s: no hyphen standing in for a dash or colon', (locale) => {
    const messages = JSON.parse(readFileSync(join(LOCALES, locale, 'common.json'), 'utf8'));
    expect(messages.email_composer.send_recipients_rejected).not.toContain(' - ');
  });
});
