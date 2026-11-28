/**
 * @vitest-environment node
 *
 * PLUGIN_FRAME_SUBDOMAIN: privileged plugin frames load from
 * <label>.<webmail host> instead of the webmail's own origin, so the webmail's
 * scripts and a privileged plugin cannot reach into each other
 * (lib/plugin-sandbox/frame-origin.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  parsePluginFrameLabel,
  pluginFrameOriginFor,
  webmailOriginOfPluginHost,
} from '@/lib/plugin-sandbox/frame-origin';

describe('the setting is one DNS label', () => {
  it.each([
    ['plugins', 'plugins'],
    [' Plugins ', 'plugins'],
    ['p', 'p'],
    ['mail-plugins-2', 'mail-plugins-2'],
  ])('takes %j', (value, label) => {
    expect(parsePluginFrameLabel(value)).toBe(label);
  });

  it.each([
    '', '   ', 'plugins.example.org', 'https://plugins.example.org', '-plugins', 'plugins-',
    'plug_ins', 'plug ins', '*', 'a'.repeat(64), 'plugins/', "plugins'", 'plugins;',
  ])('is off for %j', (value) => {
    expect(parsePluginFrameLabel(value)).toBe('');
  });

  it.each([undefined, null, true, 5, {}])('is off for a value that is not a string (%j)', (value) => {
    expect(parsePluginFrameLabel(value)).toBe('');
  });
});

describe('the plugin origin of a webmail', () => {
  it.each([
    ['https://mail.example.org', 'https://plugins.mail.example.org'],
    ['https://mail.example.org:8443', 'https://plugins.mail.example.org:8443'],
    ['http://localhost:3000', 'http://plugins.localhost:3000'],
    ['https://webmail', 'https://plugins.webmail'],
  ])('%s -> %s', (webmail, plugin) => {
    expect(pluginFrameOriginFor(webmail, 'plugins')).toBe(plugin);
  });

  it('is none while the setting is off', () => {
    expect(pluginFrameOriginFor('https://mail.example.org', '')).toBeNull();
  });

  // An IP address has no subdomains.
  it.each(['http://127.0.0.1:3000', 'https://10.0.0.5', 'http://[::1]:3000', 'not a url', 'ftp://mail.example.org'])(
    'is none for %s', (webmail) => {
      expect(pluginFrameOriginFor(webmail, 'plugins')).toBeNull();
    },
  );
});

describe('the webmail a plugin host belongs to', () => {
  it.each([
    ['https://plugins.mail.example.org', 'https://mail.example.org'],
    ['https://PLUGINS.mail.example.org:8443', 'https://mail.example.org:8443'],
    ['http://plugins.localhost:3000', 'http://localhost:3000'],
  ])('%s -> %s', (plugin, webmail) => {
    expect(webmailOriginOfPluginHost(plugin, 'plugins')).toBe(webmail);
  });

  it('round-trips with the plugin origin', () => {
    const webmail = 'https://mail.example.org';
    expect(webmailOriginOfPluginHost(pluginFrameOriginFor(webmail, 'plugins')!, 'plugins')).toBe(webmail);
  });

  it.each([
    'https://mail.example.org',          // the webmail itself
    'https://myplugins.mail.example.org', // the label is a whole label
    'https://mail.plugins.example.org',   // and the first one
    'https://plugins.com',                // not a plugin host of "com"
    'https://plugins',
    'not a url',
  ])('is none for %s', (origin) => {
    expect(webmailOriginOfPluginHost(origin, 'plugins')).toBeNull();
  });

  it('is none while the setting is off', () => {
    expect(webmailOriginOfPluginHost('https://plugins.mail.example.org', '')).toBeNull();
  });

  // A host name the operator does not own gives a different origin, with a
  // storage of its own: it names its own webmail, never the real one.
  it('names the webmail of the host that was asked, whoever owns it', () => {
    expect(webmailOriginOfPluginHost('https://plugins.attacker.example', 'plugins')).toBe('https://attacker.example');
  });
});
