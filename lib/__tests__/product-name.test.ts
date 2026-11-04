// @vitest-environment node
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { productName } from '../product-name';

describe('productName', () => {
  it('uses the configured app name', () => {
    expect(productName('Acme Mail')).toBe('Acme Mail');
    expect(productName(' Acme Mail ')).toBe('Acme Mail');
  });

  it('keeps Bulwark on a stock install', () => {
    expect(productName('Webmail')).toBe('Bulwark');
    expect(productName('')).toBe('Bulwark');
    expect(productName('  ')).toBe('Bulwark');
    expect(productName(undefined)).toBe('Bulwark');
    expect(productName(null)).toBe('Bulwark');
  });
});

// Strings that speak about this deployment name it through {appName}, so a
// branded install does not tell its users about "Bulwark".
const APP_NAME_KEYS = [
  'protocol_handlers.description',
  'protocol_handlers.mailto_description',
  'protocol_handlers.protocol_open_mode_description',
  'protocol_handlers.focus_notification_title',
  'protocol_handlers.focus_notification_body',
  'protocol_handlers.webcal_description',
  'protocol_handlers.browser_note',
  'protocol_handlers.mailto_label',
  'protocol_handlers.webcal_label',
  'protocol_handlers.register_mailto',
  'protocol_handlers.register_webcal',
  'settings.notifications.push.title',
  'common.rate_limited_detail',
  'common.rate_limited_action_detail',
  'plugins.permissions.http_proxy.body',
  'plugins.connect.intro_password',
  'plugins.connect.intro_password_any',
  'plugins.connect.intro_signin',
];

const localesDir = path.resolve(__dirname, '../../locales');
const locales = fs.readdirSync(localesDir).filter((l) => fs.statSync(path.join(localesDir, l)).isDirectory());

function lookup(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), obj);
}

describe('app name in locale strings', () => {
  it.each(locales)('%s does not hardcode Bulwark where {appName} belongs', (locale) => {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'common.json'), 'utf-8'));
    const hardcoded = APP_NAME_KEYS.filter((key) => String(lookup(data, key)).includes('Bulwark'));
    expect(hardcoded).toEqual([]);
  });

  it('en names the app in every listed string', () => {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'common.json'), 'utf-8'));
    const missing = APP_NAME_KEYS.filter((key) => !String(lookup(data, key)).includes('{appName}'));
    expect(missing).toEqual([]);
  });
});
