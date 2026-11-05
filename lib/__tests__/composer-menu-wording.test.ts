// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// compose-p3-15: the Templates menu's entries open dialogs but had no "…";
// the body's placeholder ended in three dots; the chip menu said "Move to
// CC" where the field buttons say "Cc"; the German tooltip of a disabled
// Send read like a menu path.

const dir = path.join(process.cwd(), 'locales');
const locales = readdirSync(dir).filter((l) => statSync(path.join(dir, l)).isDirectory());
const composer = (locale: string) =>
  (JSON.parse(readFileSync(path.join(dir, locale, 'common.json'), 'utf8')) as { email_composer: Record<string, unknown> }).email_composer;

describe('composer wording', () => {
  it.each(locales)('%s: dialog entries end in "…", the placeholder has no three dots', (locale) => {
    const strings = composer(locale);
    expect(strings.insert_template).toMatch(/…$/);
    expect(strings.save_as_template).toMatch(/…$/);
    expect(strings.body_placeholder).not.toMatch(/\.\.\.$/);
  });

  it('names the fields Cc and Bcc, as their buttons do', () => {
    expect(composer('en').cc).toBe('Cc');
    expect(composer('en').bcc).toBe('Bcc');
  });

  it('asks in German for a recipient in a sentence', () => {
    expect((composer('de').validation as Record<string, string>).recipient_required).toBe('Fügen Sie einen Empfänger hinzu, um zu senden');
  });
});
