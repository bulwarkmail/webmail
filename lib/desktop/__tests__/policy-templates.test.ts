import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_KEYS, POLICY_RECOMMENDED_SUBKEY, POLICY_REGISTRY_ROOT, POLICY_SCHEMA, parsePolicyValue, resolvePolicies, type PolicyKey } from '../policy-schema';
import { generateAdml, generateAdmx, generateMobileconfig, generatePoliciesJson, generatePolicyFiles } from '../policy-templates';

const NS = 'http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions';
const OUT = path.join(process.cwd(), 'desktop-policies');

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(`not well-formed: ${error.textContent}`);
  return doc;
}

function all(doc: Document | Element, name: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS(NS, name));
}

function direct(element: Element, name: string): Element[] {
  return Array.from(element.children).filter((child) => child.localName === name);
}

describe('the committed templates', () => {
  it('are what the schema generates', () => {
    for (const [name, content] of Object.entries(generatePolicyFiles())) {
      const file = path.join(OUT, name);
      expect(existsSync(file), `${name} is missing: run node scripts/generate-desktop-policies.mjs`).toBe(true);
      expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `${name} differs: run node scripts/generate-desktop-policies.mjs`).toBe(content);
    }
  });

  it('has no file the generator does not write', () => {
    const found: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        else found.push(`${prefix}${entry.name}`);
      }
    };
    walk(OUT, '');
    expect(found.sort()).toEqual(Object.keys(generatePolicyFiles()).sort());
  });
});

describe('the desktop repo', () => {
  // Only in a checkout with repos/desktop next to the code. CI's desktop repo has no webmail beside it.
  const copy = path.join(process.cwd(), 'repos', 'desktop', 'src', 'shared', 'policy-schema.ts');

  it.runIf(existsSync(copy))('holds the same schema: run node scripts/generate-desktop-policies.mjs --shell repos/desktop', () => {
    const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    expect(text(copy)).toBe(text(path.join(process.cwd(), 'lib', 'desktop', 'policy-schema.ts')));
  });
});

describe('the ADMX', () => {
  const doc = parseXml(generateAdmx());
  const root = doc.documentElement;

  it('has the root, namespace and revisions Group Policy needs', () => {
    expect(root.localName).toBe('policyDefinitions');
    expect(root.namespaceURI).toBe(NS);
    expect(root.getAttribute('revision')).toMatch(/^\d+\.\d+$/);
    expect(root.getAttribute('schemaVersion')).toBe('1.0');
    expect(Array.from(root.children).map((child) => child.localName)).toEqual(['policyNamespaces', 'resources', 'supportedOn', 'categories', 'policies']);
    const target = all(doc, 'target')[0];
    expect(target.getAttribute('prefix')).toBeTruthy();
    expect(target.getAttribute('namespace')).toBe('Bulwark.Policies.Desktop');
    expect(all(doc, 'resources')[0].getAttribute('minRequiredRevision')).toBe('1.0');
  });

  it('every policy has a real parent category and a supportedOn that exists', () => {
    const categories = new Set(all(doc, 'category').map((c) => c.getAttribute('name')));
    const supported = new Set(all(doc, 'definition').map((d) => d.getAttribute('name')));
    expect(supported.size).toBe(1);
    for (const category of all(doc, 'category')) {
      for (const parent of direct(category, 'parentCategory')) expect(categories.has(parent.getAttribute('ref'))).toBe(true);
    }
    const policies = all(doc, 'policy');
    expect(policies.length).toBeGreaterThan(POLICY_KEYS.length);
    for (const policy of policies) {
      const name = policy.getAttribute('name');
      expect(categories.has(direct(policy, 'parentCategory')[0]?.getAttribute('ref')), `${name} category`).toBe(true);
      expect(supported.has(direct(policy, 'supportedOn')[0]?.getAttribute('ref')), `${name} supportedOn`).toBe(true);
      expect(policy.getAttribute('class')).toBe('Both');
      expect(policy.getAttribute('key')?.startsWith(POLICY_REGISTRY_ROOT)).toBe(true);
    }
  });

  it('keeps the children of a policy in the order the schema requires', () => {
    const order = ['parentCategory', 'seeAlso', 'keywords', 'supportedOn', 'enabledValue', 'disabledValue', 'enabledList', 'disabledList', 'elements'];
    for (const policy of all(doc, 'policy')) {
      const names = Array.from(policy.children).map((child) => order.indexOf(child.localName));
      expect(names, policy.getAttribute('name') ?? '').toEqual([...names].sort((a, b) => a - b));
      expect(names).not.toContain(-1);
    }
  });

  it('every key is there, forced and (except the wipe) as a default', () => {
    const names = new Set(all(doc, 'policy').map((p) => p.getAttribute('name')));
    for (const key of POLICY_KEYS) {
      expect(names.has(key), key).toBe(true);
      expect(names.has(`${key}_Recommended`), `${key}_Recommended`).toBe(!POLICY_SCHEMA[key].forcedOnly);
    }
    expect(names.has('WipeOfflineData_Recommended')).toBe(false);
  });

  it('puts list policies under their own subkey with numbered values', () => {
    const lists = POLICY_KEYS.filter((key) => POLICY_SCHEMA[key].type === 'list');
    expect(lists).toEqual(['AllowedJmapServers', 'PluginAllowlist', 'AutoSelectCertificateForUrls']);
    for (const key of lists) {
      const forced = all(doc, 'policy').find((p) => p.getAttribute('name') === key)!;
      expect(forced.getAttribute('key')).toBe(`${POLICY_REGISTRY_ROOT}\\${key}`);
      expect(forced.getAttribute('valueName')).toBeNull();
      const list = all(forced, 'list')[0];
      // Empty prefix is what makes Windows name the values 1, 2, 3.
      expect(list.getAttribute('valuePrefix')).toBe('');
      const recommended = all(doc, 'policy').find((p) => p.getAttribute('name') === `${key}_Recommended`)!;
      expect(recommended.getAttribute('key')).toBe(`${POLICY_REGISTRY_ROOT}\\${POLICY_RECOMMENDED_SUBKEY}\\${key}`);
    }
  });

  it('writes booleans as 1 and 0 under the policy\'s value name', () => {
    const policy = all(doc, 'policy').find((p) => p.getAttribute('name') === 'AllowStandalone')!;
    expect(policy.getAttribute('valueName')).toBe('AllowStandalone');
    expect(all(direct(policy, 'enabledValue')[0], 'decimal')[0].getAttribute('value')).toBe('1');
    expect(all(direct(policy, 'disabledValue')[0], 'decimal')[0].getAttribute('value')).toBe('0');
  });

  it('writes the enum values the parser accepts', () => {
    const policy = all(doc, 'policy').find((p) => p.getAttribute('name') === 'PluginsMode')!;
    const values = all(policy, 'string').map((s) => s.textContent);
    expect(values).toEqual(['allowed', 'allowlist', 'off']);
    for (const value of values) expect(parsePolicyValue('PluginsMode', value).ok).toBe(true);
  });

  it.each(['en', 'de'] as const)('every reference resolves in the %s ADML', (language) => {
    const adml = parseXml(generateAdml(language));
    expect(adml.documentElement.localName).toBe('policyDefinitionResources');
    expect(adml.documentElement.namespaceURI).toBe(NS);
    const strings = new Set(all(adml, 'string').map((s) => s.getAttribute('id')));
    const presentations = new Map(all(adml, 'presentation').map((p) => [p.getAttribute('id'), p]));
    const text = generateAdmx();
    const stringRefs = [...text.matchAll(/\$\(string\.([^)]+)\)/g)].map((m) => m[1]);
    expect(stringRefs.length).toBeGreaterThan(40);
    for (const id of stringRefs) expect(strings.has(id), id).toBe(true);
    for (const policy of all(doc, 'policy')) {
      const presentation = policy.getAttribute('presentation');
      const elements = direct(policy, 'elements')[0];
      if (!elements) {
        expect(presentation).toBeNull();
        continue;
      }
      const id = /^\$\(presentation\.(.+)\)$/.exec(presentation ?? '')?.[1];
      expect(id, policy.getAttribute('name') ?? '').toBeTruthy();
      const shown = presentations.get(id!);
      expect(shown, id).toBeTruthy();
      // Each input of the policy has a control that refers to it by id.
      const refs = Array.from(shown!.children).map((child) => child.getAttribute('refId'));
      expect(refs).toEqual(Array.from(elements.children).map((child) => child.getAttribute('id')));
    }
  });

  it('the German text is German and every id is the same as in English', () => {
    const ids = (language: 'en' | 'de') => all(parseXml(generateAdml(language)), 'string').map((s) => s.getAttribute('id'));
    expect(ids('de')).toEqual(ids('en'));
    expect(generateAdml('de')).toContain('Zugelassene Mailserver');
    expect(generateAdml('en')).not.toContain('Zugelassene Mailserver');
  });
});

describe('the samples', () => {
  it('the policies.json parses, with nothing refused, and the wipe not set', () => {
    const parsed = JSON.parse(generatePoliciesJson()) as Record<string, unknown> & { Recommended: Record<string, unknown> };
    const { Recommended, ...forced } = parsed;
    const snapshot = resolvePolicies({ forcedMachine: forced, forcedUser: {}, recommendedMachine: Recommended, recommendedUser: {} });
    for (const key of POLICY_KEYS) {
      expect(snapshot[key].invalid, key).toBeUndefined();
      expect(snapshot[key].dropped, key).toBeUndefined();
    }
    expect(snapshot.InstanceUrl.value).toBe('https://mail.example.com/');
    expect(snapshot.UpdateChannel.source).toBe('recommended-machine');
    expect(snapshot.WipeOfflineData.value).toBeNull();
  });

  it('the mobileconfig is a well-formed plist for the app\'s bundle id, with stable ids', () => {
    const text = generateMobileconfig();
    const doc = parseXml(text);
    expect(doc.documentElement.localName).toBe('plist');
    expect(text).toContain('<string>org.bulwarkmail.desktop</string>');
    expect(text).not.toContain('WipeOfflineData');
    const uuids = [...text.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(uuids).toHaveLength(2);
    expect(new Set(uuids).size).toBe(2);
    for (const uuid of uuids) expect(uuid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(generateMobileconfig()).toBe(text);
    const keys: PolicyKey[] = ['InstanceUrl', 'AllowedJmapServers', 'PluginsMode'];
    for (const key of keys) expect(text).toContain(`<key>${key}</key>`);
  });
});
