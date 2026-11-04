import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY_SNAPSHOT,
  EMPTY_POLICY_LAYERS,
  POLICY_KEYS,
  policyProblems,
  POLICY_CONSUMERS,
  POLICY_MAX_LIST_ITEMS,
  POLICY_SCHEMA,
  certificateMatchesRule,
  certificateRuleMatchesUrl,
  effectivePolicyValue,
  jmapServerAllowed,
  parseCertificateRule,
  parseInstanceUrl,
  parsePolicyValue,
  parseServerPattern,
  pluginAllowedByPolicy,
  resolvePolicies,
  serverPolicyOf,
  type PolicyLayers,
} from '../policy-schema';

const layers = (partial: Partial<PolicyLayers>): PolicyLayers => ({ ...EMPTY_POLICY_LAYERS, ...partial });

describe('the schema', () => {
  it('has every key the build asked for, with text in both languages', () => {
    expect(POLICY_KEYS).toEqual([
      'InstanceUrl', 'AllowStandalone', 'AllowedJmapServers', 'AllowInsecureInstance', 'UpdateChannel', 'AutoUpdate',
      'PluginsMode', 'PluginAllowlist', 'OfflineEnabled', 'AppLockRequired', 'AppLockTimeoutMinutes', 'TelemetryAllowed',
      'CrashReportsAllowed', 'QuickComposeShortcut', 'AuthServerAllowlist', 'AuthNegotiateDelegateAllowlist',
      'AutoSelectCertificateForUrls', 'KeystoreEnabled', 'KeystoreAllowedOrigins', 'BrowserSignIn', 'WipeOfflineData',
      'OpenWithEnabled', 'DeveloperToolsAvailability',
    ]);
    for (const key of POLICY_KEYS) {
      const { title, description } = POLICY_SCHEMA[key];
      expect(title.en && title.de && description.en && description.de, key).toBeTruthy();
      expect(description.en, key).not.toBe(description.de);
    }
  });
});

describe('developer tools and Open with', () => {
  it("takes Chrome values for developer tools, forced only, and a value nobody can read locks them off", () => {
    expect(resolvePolicies(layers({ forcedMachine: { DeveloperToolsAvailability: 2 } })).DeveloperToolsAvailability).toMatchObject({ value: 2, locked: true });
    expect(resolvePolicies(layers({ recommendedMachine: { DeveloperToolsAvailability: 2 } })).DeveloperToolsAvailability).toMatchObject({ value: null, locked: false });
    // Not 0 or 1: the shell reads a locked entry that isn't an explicit yes as off.
    expect(resolvePolicies(layers({ forcedUser: { DeveloperToolsAvailability: 7 } })).DeveloperToolsAvailability).toMatchObject({ value: null, locked: true });
  });

  it('turn Open with off only by force, and a value nobody can read leaves it off', () => {
    expect(resolvePolicies(layers({})).OpenWithEnabled).toMatchObject({ value: true, locked: false });
    expect(resolvePolicies(layers({ recommendedUser: { OpenWithEnabled: 0 } })).OpenWithEnabled).toMatchObject({ value: true, locked: false });
    expect(resolvePolicies(layers({ forcedMachine: { OpenWithEnabled: 0 } })).OpenWithEnabled).toMatchObject({ value: false, locked: true });
    expect(resolvePolicies(layers({ forcedMachine: { OpenWithEnabled: 'maybe' } })).OpenWithEnabled).toMatchObject({ value: false, locked: true });
  });
});

describe('precedence', () => {
  it('forced machine > forced user > recommended machine > recommended user > default', () => {
    const all = {
      forcedMachine: { UpdateChannel: 'beta' },
      forcedUser: { UpdateChannel: 'stable', AutoUpdate: 0 },
      recommendedMachine: { UpdateChannel: 'stable', AutoUpdate: 1, AppLockTimeoutMinutes: 5 },
      recommendedUser: { AppLockTimeoutMinutes: 9, QuickComposeShortcut: 'Ctrl+Alt+M' },
    };
    const snapshot = resolvePolicies(all);
    expect(resolvePolicies(layers({ recommendedMachine: { PluginsMode: 'off' } })).PluginsMode).toMatchObject({ value: 'allowed', source: 'default' });
    expect(snapshot.UpdateChannel).toMatchObject({ value: 'beta', source: 'forced-machine', locked: true });
    expect(snapshot.AutoUpdate).toMatchObject({ value: false, source: 'forced-user', locked: true });
    expect(snapshot.AppLockTimeoutMinutes).toMatchObject({ value: 5, source: 'recommended-machine', locked: false });
    expect(snapshot.QuickComposeShortcut).toMatchObject({ value: 'Ctrl+Alt+M', source: 'recommended-user', locked: false });
    expect(snapshot.PluginsMode).toMatchObject({ value: 'allowed', source: 'default', locked: false });
  });

  it('the user\'s choice sits under forced and over recommended', () => {
    const snapshot = resolvePolicies(layers({ forcedUser: { AutoUpdate: 0 }, recommendedMachine: { OfflineEnabled: 0 } }));
    expect(effectivePolicyValue(snapshot.AutoUpdate, true)).toBe(false);
    expect(effectivePolicyValue(snapshot.OfflineEnabled, true)).toBe(true);
    expect(effectivePolicyValue(snapshot.OfflineEnabled, null)).toBe(false);
    expect(effectivePolicyValue(snapshot.TelemetryAllowed, undefined)).toBe(true);
  });

  it('takes a whole list from the strongest level and doesn\'t add them up', () => {
    const snapshot = resolvePolicies(layers({
      forcedMachine: { AllowedJmapServers: ['https://a.example'] },
      forcedUser: { AllowedJmapServers: ['https://b.example'] },
    }));
    expect(snapshot.AllowedJmapServers.value).toEqual(['https://a.example']);
  });

  it('a wipe can only be forced', () => {
    expect(resolvePolicies(layers({ recommendedMachine: { WipeOfflineData: 'x' } })).WipeOfflineData.value).toBeNull();
    expect(resolvePolicies(layers({ forcedUser: { WipeOfflineData: 'x' } })).WipeOfflineData).toMatchObject({ value: 'x', locked: true });
  });
});

describe('only a forced value counts for what decides what is allowed', () => {
  it.each(['AllowStandalone', 'AllowedJmapServers', 'AllowInsecureInstance', 'PluginsMode', 'PluginAllowlist', 'AuthServerAllowlist', 'AuthNegotiateDelegateAllowlist', 'AutoSelectCertificateForUrls', 'KeystoreAllowedOrigins', 'WipeOfflineData'] as const)('%s', (key) => {
    expect(POLICY_SCHEMA[key].forcedOnly).toBe(true);
  });

  it('a recommended AllowInsecureInstance can\'t let a forced http address through', () => {
    const snapshot = resolvePolicies(layers({ forcedMachine: { InstanceUrl: 'http://bulwark.lan' }, recommendedMachine: { AllowInsecureInstance: 1 } }));
    expect(snapshot.InstanceUrl).toMatchObject({ value: null, invalid: 'insecure' });
  });
});

describe('hostile values fail closed', () => {
  const junk: unknown[] = [{}, [], null, 'a'.repeat(100_000), Number.NaN, { toString: 'x' }, ['x'], -1];

  it.each(POLICY_KEYS)('%s: junk never throws, and never comes out wider than it went in', (key) => {
    for (const raw of junk) {
      const snapshot = resolvePolicies(layers({ forcedMachine: { [key]: raw } }));
      expect(snapshot[key].locked).toBe(true);
    }
  });

  it('forced values that make no sense take the strict side, and a weaker level never speaks instead', () => {
    const snapshot = resolvePolicies(layers({
      forcedMachine: { AllowStandalone: 'maybe', PluginsMode: 'banana', OfflineEnabled: 7, TelemetryAllowed: 'yes', AppLockRequired: 'no', AllowedJmapServers: 'https://a.example', QuickComposeShortcut: 'rm -rf' },
      recommendedMachine: { TelemetryAllowed: 1 },
    }));
    expect(snapshot.AllowStandalone).toMatchObject({ value: false, locked: true, invalid: 'not_a_switch' });
    expect(snapshot.PluginsMode).toMatchObject({ value: 'off', locked: true, invalid: 'unknown_value' });
    expect(snapshot.OfflineEnabled.value).toBe(false);
    expect(snapshot.TelemetryAllowed.value).toBe(false);
    expect(snapshot.AppLockRequired.value).toBe(true);
    // A list that isn't one allows nothing, rather than everything.
    expect(snapshot.AllowedJmapServers).toMatchObject({ value: [], invalid: 'not_a_list' });
    expect(snapshot.QuickComposeShortcut.value).toBe('off');
  });

  it('a recommendation that makes no sense is simply not one', () => {
    const snapshot = resolvePolicies(layers({ recommendedMachine: { UpdateChannel: 'banana' }, recommendedUser: { UpdateChannel: 'beta' } }));
    expect(snapshot.UpdateChannel).toMatchObject({ value: 'beta', source: 'recommended-user', locked: false });
    expect(snapshot.UpdateChannel.invalid).toBeUndefined();
  });

  it('a list over the cap is refused as a whole, and bad entries drop out one by one', () => {
    const tooLong = Array.from({ length: POLICY_MAX_LIST_ITEMS + 1 }, (_, i) => `plugin-${i}`);
    expect(resolvePolicies(layers({ forcedMachine: { PluginAllowlist: tooLong } })).PluginAllowlist).toMatchObject({ value: [], invalid: 'too_many' });
    expect(resolvePolicies(layers({ forcedMachine: { PluginAllowlist: ['good', '../evil', 7, 'also-good'] } })).PluginAllowlist).toMatchObject({ value: ['good', 'also-good'], dropped: 2 });
  });

  it('keeps what was set for the error page, capped', () => {
    const entry = resolvePolicies(layers({ forcedMachine: { InstanceUrl: `ftp://${'a'.repeat(500)}` } })).InstanceUrl;
    expect(entry.invalid).toBe('scheme');
    expect(entry.raw!.length).toBeLessThanOrEqual(201);
  });

  it('an out of range timeout falls to the shortest, not to a huge one or the user\'s own', () => {
    const entry = resolvePolicies(layers({ forcedMachine: { AppLockTimeoutMinutes: 999999 } })).AppLockTimeoutMinutes;
    expect(entry).toMatchObject({ value: 1, invalid: 'out_of_range' });
  });
});

describe('InstanceUrl', () => {
  it.each([
    ['https://mail.example.com', 'https://mail.example.com/'],
    ['  https://mail.example.com/  ', 'https://mail.example.com/'],
    ['https://Mail.Example.com:8443/bulwark//', 'https://mail.example.com:8443/bulwark/'],
  ])('%s is fine', (raw, value) => {
    expect(parseInstanceUrl(raw, false)).toEqual({ ok: true, value });
  });

  it.each([
    ['http://mail.example.com', 'insecure'],
    ['file:///c:/x', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,x', 'scheme'],
    ['https://user:pw@mail.example.com', 'invalid_url'],
    ['https://mail.example.com/?x=1', 'invalid_url'],
    ['https://mail.example.com/#x', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['', 'empty'],
    [`https://${'a'.repeat(3000)}.com`, 'too_long'],
    ['https://exa\nmple.com', 'invalid_url'],
    ['https://exa_mple.com', 'invalid_url'],
    ['https://exa"mple.com', 'invalid_url'],
    [42, 'not_text'],
  ])('%s is refused', (raw, reason) => {
    expect(parseInstanceUrl(raw, false)).toEqual({ ok: false, reason });
  });

  it('takes an international name as its punycode, and IP literals', () => {
    expect(parseInstanceUrl('https://müller.de', false)).toEqual({ ok: true, value: 'https://xn--mller-kva.de/' });
    expect(parseInstanceUrl('https://10.0.0.5:8443', false)).toEqual({ ok: true, value: 'https://10.0.0.5:8443/' });
    expect(parseInstanceUrl('https://[::1]/', false)).toEqual({ ok: true, value: 'https://[::1]/' });
  });

  it('allows http only with AllowInsecureInstance, resolved from the policies', () => {
    expect(resolvePolicies(layers({ forcedMachine: { InstanceUrl: 'http://bulwark.lan' } })).InstanceUrl).toMatchObject({ value: null, invalid: 'insecure' });
    expect(resolvePolicies(layers({ forcedMachine: { InstanceUrl: 'http://bulwark.lan', AllowInsecureInstance: 1 } })).InstanceUrl).toMatchObject({ value: 'http://bulwark.lan/' });
    expect(parseInstanceUrl('file:///x', true).ok).toBe(false);
  });
});

describe('AllowedJmapServers', () => {
  it.each([
    ['https://mail.example.com', 'https://mail.example.com'],
    ['mail.example.com', 'https://mail.example.com'],
    ['https://mail.example.com/', 'https://mail.example.com'],
    ['http://10.0.0.5:8080', 'http://10.0.0.5:8080'],
    ['https://*.example.com', 'https://*.example.com'],
    ['*.example.com', 'https://*.example.com'],
    ['HTTPS://Mail.Example.COM', 'https://mail.example.com'],
  ])('%s becomes %s', (raw, pattern) => {
    expect(parseServerPattern(raw)).toBe(pattern);
  });

  it.each(['*', 'https://*', 'https://*.com', 'ftp://a.example', 'https://a.example/path', 'https://u:p@a.example', 'https://a.*.example', 'a b', '', 3])('%s is refused', (raw) => {
    expect(parseServerPattern(raw)).toBeNull();
  });

  it('matches by scheme, host and port, and a wildcard only covers subdomains', () => {
    const list = ['https://mail.example.com', 'https://*.corp.example'];
    expect(jmapServerAllowed(list, 'https://mail.example.com/jmap/session')).toBe(true);
    expect(jmapServerAllowed(list, 'http://mail.example.com')).toBe(false);
    expect(jmapServerAllowed(list, 'https://mail.example.com:8443')).toBe(false);
    expect(jmapServerAllowed(list, 'https://a.corp.example')).toBe(true);
    expect(jmapServerAllowed(list, 'https://corp.example')).toBe(false);
    expect(jmapServerAllowed(list, 'https://evilcorp.example')).toBe(false);
    expect(jmapServerAllowed(list, 'https://mail.example.com.evil.test')).toBe(false);
    expect(jmapServerAllowed(list, 'https://user:pw@mail.example.com')).toBe(false);
    expect(jmapServerAllowed(list, 42)).toBe(false);
    expect(jmapServerAllowed(list, 'nonsense')).toBe(false);
  });

  it('no list allows everything, an empty list nothing', () => {
    expect(jmapServerAllowed(null, 'https://anything.example')).toBe(true);
    expect(jmapServerAllowed([], 'https://anything.example')).toBe(false);
  });
});

describe('plugins', () => {
  it('allowed lets anything through, allowlist only what is listed, off nothing', () => {
    expect(pluginAllowedByPolicy('allowed', [], 'x')).toBe(true);
    expect(pluginAllowedByPolicy('allowlist', ['x'], 'x')).toBe(true);
    expect(pluginAllowedByPolicy('allowlist', ['x'], 'X')).toBe(true);
    expect(pluginAllowedByPolicy('allowlist', ['x'], 'y')).toBe(false);
    expect(pluginAllowedByPolicy('allowlist', [], 'x')).toBe(false);
    expect(pluginAllowedByPolicy('off', ['x'], 'x')).toBe(false);
    expect(pluginAllowedByPolicy('allowlist', ['x'], undefined)).toBe(false);
  });
});

describe('sign-in lists', () => {
  it('passes names and wildcards through, without spaces', () => {
    expect(parsePolicyValue('AuthServerAllowlist', '*.example.com, intranet')).toEqual({ ok: true, value: '*.example.com,intranet' });
  });

  it.each(['*', '*.example.com,*', '*.com', '*example.com', 'a.*.example.com', '*.', 'a b', '--no-sandbox x', 'a"b', 'a;b', ''])('%s is refused', (raw) => {
    expect(parsePolicyValue('AuthServerAllowlist', raw).ok).toBe(false);
  });

  it('a forced refused list isn\'t applied at all', () => {
    expect(resolvePolicies(layers({ forcedMachine: { AuthServerAllowlist: '*' } })).AuthServerAllowlist).toMatchObject({ value: null, invalid: 'invalid_host_list', locked: true });
  });
});

describe('QuickComposeShortcut', () => {
  it.each(['Ctrl+Alt+N', 'CommandOrControl+Shift+M', 'Alt+F4'])('%s is a shortcut', (raw) => {
    expect(parsePolicyValue('QuickComposeShortcut', raw)).toEqual({ ok: true, value: raw });
  });
  it.each(['off', 'OFF', ''])('"%s" turns it off', (raw) => {
    expect(parsePolicyValue('QuickComposeShortcut', raw)).toEqual({ ok: true, value: 'off' });
  });
  it.each(['N', 'Ctrl+', 'Ctrl+Alt+Banana', 'Ctrl+Alt', 7])('%s is refused', (raw) => {
    expect(parsePolicyValue('QuickComposeShortcut', raw).ok).toBe(false);
  });
});

describe('WipeOfflineData', () => {
  it('takes text and numbers, and empty is nobody asking', () => {
    expect(parsePolicyValue('WipeOfflineData', '2026-11-03')).toEqual({ ok: true, value: '2026-11-03' });
    expect(parsePolicyValue('WipeOfflineData', 7)).toEqual({ ok: true, value: '7' });
    expect(resolvePolicies(layers({ forcedMachine: { WipeOfflineData: '  ' } })).WipeOfflineData).toMatchObject({ value: null, locked: false });
    expect(resolvePolicies(layers({ forcedMachine: { WipeOfflineData: 'x'.repeat(129) } })).WipeOfflineData.value).toBeNull();
  });
});

describe('AutoSelectCertificateForUrls', () => {
  const rule = (pattern: unknown, filter?: unknown) => JSON.stringify({ pattern, filter });

  it('reads Chrome\'s format', () => {
    expect(parseCertificateRule('{"pattern":"https://[*.]example.com","filter":{"ISSUER":{"CN":"Example CA"}}}')).toEqual({
      host: 'example.com', subdomains: true, issuer: { CN: 'Example CA' },
    });
    expect(parseCertificateRule(rule('https://mail.example.com:8443', { SUBJECT: { O: 'Acme' } }))).toEqual({
      host: 'mail.example.com:8443', subdomains: false, subject: { O: 'Acme' },
    });
    expect(parseCertificateRule(rule('example.com'))).toEqual({ host: 'example.com', subdomains: false });
  });

  it.each([
    ['not json'],
    ['[]'],
    ['null'],
    [rule('*')],
    [rule('https://*')],
    [rule('http://example.com')],
    [rule('https://example.com/path')],
    [rule('https://exa mple.com')],
    [rule(7)],
    [rule('https://example.com', 'x')],
    [rule('https://example.com', { ISSUER: 'x' })],
    [rule('https://example.com', { ISSUER: { CN: 7 } })],
    [JSON.stringify({ pattern: `https://${'a'.repeat(5000)}.com` })],
  ])('%s is refused', (raw) => {
    expect(parseCertificateRule(raw)).toBeNull();
  });

  it('matches https only, and subdomains only when the rule says so', () => {
    const wide = parseCertificateRule(rule('[*.]example.com'))!;
    const exact = parseCertificateRule(rule('example.com'))!;
    expect(certificateRuleMatchesUrl(wide, 'https://a.example.com/x')).toBe(true);
    expect(certificateRuleMatchesUrl(wide, 'https://example.com')).toBe(true);
    expect(certificateRuleMatchesUrl(exact, 'https://a.example.com')).toBe(false);
    expect(certificateRuleMatchesUrl(wide, 'http://a.example.com')).toBe(false);
    expect(certificateRuleMatchesUrl(wide, 'https://aexample.com')).toBe(false);
    expect(certificateRuleMatchesUrl(wide, 'garbage')).toBe(false);
  });

  it('picks by issuer and subject', () => {
    const parsed = parseCertificateRule(rule('example.com', { ISSUER: { CN: 'Ca', O: 'Org' }, SUBJECT: { OU: 'Unit' } }))!;
    const good = { issuer: { commonName: 'Ca', organizations: ['Org'] }, subject: { organizationUnits: ['Unit'] } };
    expect(certificateMatchesRule(parsed, good)).toBe(true);
    expect(certificateMatchesRule(parsed, { ...good, issuer: { commonName: 'Other', organizations: ['Org'] } })).toBe(false);
    expect(certificateMatchesRule(parsed, { ...good, subject: {} })).toBe(false);
    expect(certificateMatchesRule(parseCertificateRule(rule('example.com'))!, {})).toBe(true);
  });
});

describe('KeystoreAllowedOrigins', () => {
  it('takes https origins and drops the rest', () => {
    expect(resolvePolicies(layers({ forcedMachine: { KeystoreAllowedOrigins: ['https://mail.example.com/', 'http://mail.example.com', 'https://mail.example.com/path', 'nonsense'] } })).KeystoreAllowedOrigins).toMatchObject({ value: ['https://mail.example.com'], dropped: 3 });
  });
});

describe('what a recommendation can do', () => {
  it.each(['AppLockRequired', 'TelemetryAllowed', 'CrashReportsAllowed', 'AutoUpdate'] as const)('%s: nothing, and the templates do not offer one', (key) => {
    expect(POLICY_SCHEMA[key].forcedOnly).toBe(true);
    expect(resolvePolicies({ ...EMPTY_POLICY_LAYERS, recommendedMachine: { [key]: 0 } })[key]).toMatchObject({ source: 'default', locked: false });
    expect(resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine: { [key]: 0 } })[key]).toMatchObject({ value: false, locked: true });
  });
});

describe('values that fail open', () => {
  it('a lock timeout nobody can read is the shortest there is', () => {
    expect(resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine: { AppLockTimeoutMinutes: '99999' } }).AppLockTimeoutMinutes).toMatchObject({ value: 1, locked: true, invalid: 'out_of_range' });
  });

  it('a wipe code too long to use is named as invalid', () => {
    const snapshot = resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine: { WipeOfflineData: 'w'.repeat(200) } });
    expect(snapshot.WipeOfflineData).toMatchObject({ value: null, invalid: 'too_long' });
    expect(policyProblems(snapshot).map((problem) => problem.key)).toEqual(['WipeOfflineData']);
  });
});

describe('every key has someone acting on it', () => {
  it('names a consumer or who owes one', () => {
    for (const key of POLICY_KEYS) {
      const consumer = POLICY_CONSUMERS[key];
      expect(consumer, key).toBeTruthy();
      if ('pendingConsumer' in consumer) expect(consumer.pendingConsumer.length, key).toBeGreaterThan(5);
    }
  });

  it('a consumer in this repo really reads the key', () => {
    for (const key of POLICY_KEYS) {
      const consumer = POLICY_CONSUMERS[key];
      if ('repo' in consumer && consumer.repo === 'webmail') expect(readFileSync(path.join(process.cwd(), consumer.file), 'utf8'), key).toContain(key);
    }
  });

  it('nobody is waiting any more', () => {
    expect(POLICY_KEYS.filter((key) => 'pendingConsumer' in POLICY_CONSUMERS[key])).toEqual([]);
  });
});

describe('defaults', () => {
  it('nothing set means nothing locked and nothing restricted', () => {
    for (const key of POLICY_KEYS) expect(DEFAULT_POLICY_SNAPSHOT[key]).toMatchObject({ source: 'default', locked: false });
    expect(serverPolicyOf(DEFAULT_POLICY_SNAPSHOT)).toEqual({ pluginsMode: 'allowed', pluginAllowlist: [], allowedJmapServers: null });
  });
});
