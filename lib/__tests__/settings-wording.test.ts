import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '@/locales/en/common.json';
import { getByPath } from '../settings-search';

// SET-23 / R10: one verb per action ("New …" creates, "Save" saves) and
// sentence case for labels in Settings.

const text = (key: string) => getByPath(en, key) as string;

// Words that keep their capital inside a sentence-case label.
const PROPER = /^(ASCII-armored|JMAP|Sieve|HTML|PGP|S\/MIME|TOTP|API|IPs|ASCII|BCC|Pro|Junk|Trash|Bulwark|Webmail|Siege|Spam|ID|URL|OAuth\/OIDC\)|\(OAuth\/OIDC\)|Mountain|View|Cc|To|ALL|ANY|Z|→|&)$/;

// Every word after the first, and each part of a hyphenated word after its
// first part: "Sub-Addressing" counts "Addressing".
function titleCaseWords(value: string): string[] {
  const words = value.split(/\s+/).flatMap((word, i) => {
    const parts = word.split('-');
    return i === 0 ? parts.slice(1) : parts;
  });
  return words.filter((w) => /^[A-Z]/.test(w) && !PROPER.test(w.replace(/[(),.?!]/g, '')));
}

describe('settings wording', () => {
  it('names creating "New …" and saving "Save"', () => {
    expect(text('settings.keywords.add_keyword')).toBe('New tag');
    expect(text('settings.folders.create_folder')).toBe('New folder');
    expect(text('settings.folders.create_subfolder')).toBe('New subfolder');
    expect(text('settings.filters.add_rule')).toBe('New rule');
    expect(text('identities.create_new')).toBe('New identity');
    expect(text('calendar.management.add_calendar')).toBe('New calendar');
    expect(text('settings.security.app_passwords.new')).toBe('New app password');
    expect(text('settings.security.api_keys.new')).toBe('New API key');
    // A public key and an account exist already: they are added, not created.
    expect(text('settings.security.public_keys.add')).toBe('Add public key');
    expect(text('settings.account.accounts.add')).toBe('Add account');
    expect(text('settings.vacation.save')).toBe('Save');
    expect(text('settings.filters.save')).toBe('Save');
    expect(text('identities.form.save')).toBe('Save');
  });

  it('uses sentence case for labels and titles', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        const last = path.split('.').pop() ?? '';
        if (!/(^|_)(label|title)$/.test(last) || node.includes('{')) return;
        if (path.startsWith('settings.files.')) return; // moved by the Files work
        if (titleCaseWords(node).length > 0) offenders.push(`${path}: ${node}`);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
      }
    };
    walk((en as Record<string, unknown>).settings, 'settings');
    walk((en as Record<string, unknown>).identities, 'identities');
    expect(offenders).toEqual([]);
  });

  // R9: a success toast states the result, without "successfully".
  it('reports Settings saves without "successfully"', () => {
    for (const key of [
      'notifications.filters_saved',
      'settings.filters.saved',
      'notifications.identity_created',
      'notifications.identity_updated',
      'notifications.templates_exported',
    ]) {
      expect(text(key), key).not.toMatch(/successful|!/i);
    }
    expect(text('notifications.filters_saved')).toBe('Filters saved');
  });

  // Security: App passwords come after the mail client section.
  it('sends the mail client hint to the app passwords section below it', () => {
    expect(text('settings.security.email_client.password_instructions')).toContain('in the section below');
  });

  // Settings > Contacts deletes address books and categories as well.
  it('says the contact lists can be deleted, not only renamed', () => {
    expect(text('settings.contacts.manage_description')).toBe('Rename or delete your address books');
    expect(text('settings.contacts.categories_description')).toBe('Rename or delete contact categories');
  });

  // R5: every editor asks the same question with the same buttons, in every
  // language: Settings and Contacts say what Calendar says.
  it('asks "Discard changes?" with Keep editing / Discard everywhere', () => {
    expect(text('calendar.discard.title')).toBe('Discard changes?');
    const mismatches: string[] = [];
    for (const locale of readdirSync(join(process.cwd(), 'locales'))) {
      const messages = JSON.parse(readFileSync(join(process.cwd(), 'locales', locale, 'common.json'), 'utf8'));
      const ref = getByPath(messages, 'calendar.discard') as Record<string, string>;
      const expected: Record<string, string> = {
        'settings.discard_changes': ref.title,
        'settings.unsaved_changes': ref.message,
        'settings.keep_editing': ref.keep,
        'settings.discard': ref.confirm,
        'contacts.form.discard_title': ref.title,
        'contacts.form.discard_message': ref.message,
        'contacts.form.keep_editing': ref.keep,
        'contacts.form.discard': ref.confirm,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (getByPath(messages, key) !== value) mismatches.push(`${locale} ${key}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('counts every word of a hyphenated label', () => {
    expect(titleCaseWords('Sub-Addressing')).toEqual(['Addressing']);
    expect(titleCaseWords('Sub-addressing')).toEqual([]);
  });

  it('says "Back to mail" in Settings, the admin and plugin pages', () => {
    expect(text('settings.back_to_mail')).toBe('Back to mail');
    expect(text('plugin_pages.back_to_mail')).toBe('Back to mail');
  });

  it('does not repeat the debug section title as its only row', () => {
    expect(text('settings.advanced.debug_mode.toggle')).not.toBe(text('settings.advanced.debug_mode.label'));
  });
});
