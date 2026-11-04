import { describe, expect, it } from 'vitest';
import en from '@/locales/en/common.json';
import enPlain from '@/locales/en/plain.json';
import { getByPath } from '../settings-search';
import { withPlainLanguage } from '@/i18n/plain-language';

// Usability pass 2026-11-04 (settings-11, -12, -36): settings rows say what
// they change, without product names or protocol jargon. The English text a
// user sees is common.json with the plain overlay on top.

const shown = withPlainLanguage(en as Record<string, unknown>, enPlain as Record<string, unknown>);
const text = (key: string) => getByPath(shown, key) as string;

describe('settings page wording', () => {
  it('names the colour mode row "Light or dark" and the layouts by what they do', () => {
    expect(text('settings.appearance.theme.label')).toBe('Light or dark');
    expect(text('settings.appearance.interface_layout.mountain_view')).toBe('Search bar on top, apps on the left');
    expect(text('settings.email_behavior.mail_layout.split_description')).toBe('List and message side by side');
    expect(text('settings.email_behavior.mail_layout.focus_description')).toBe('List, then the message full width');
    expect(text('settings.email_behavior.mail_layout.horizontal_description')).toBe('Message below the list');
  });

  it('uses no product names or folder names the sidebar does not show', () => {
    const values = [
      'settings.appearance.interface_layout.mountain_view',
      'settings.email_behavior.mail_layout.description',
      'settings.appearance.colorful_sidebar_icons.description',
    ].map(text).join(' ');
    expect(values).not.toMatch(/Mountain View|Gmail|Zimbra|Junk/);
    expect(text('settings.appearance.colorful_sidebar_icons.description')).toContain('red Spam');
  });

  it('describes setting up other mail apps without JMAP or TOTP', () => {
    expect(text('settings.security.email_client.title')).toBe('Use your mail in other apps');
    expect(text('settings.security.email_client.jmap_username_label')).toBe('User name');
    expect(text('settings.security.totp.label')).toBe('Two-step sign-in');
    const all = ['title', 'description', 'jmap_username_label', 'password_instructions']
      .map((k) => text(`settings.security.email_client.${k}`)).join(' ');
    expect(all).not.toMatch(/JMAP/);
  });

  it('words the contacts and calendar rows plainly', () => {
    expect(text('settings.contacts.title')).toBe('Contact list');
    expect(text('calendar.settings.invitation_parsing')).toBe('Show invitations from mail');
    expect(text('calendar.subscription.title')).toBe('Subscribe to a calendar');
    expect(text('calendar.settings.enable_tasks')).toBe('Tasks');
  });
});
