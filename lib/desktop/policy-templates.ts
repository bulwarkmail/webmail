/**
 * Turns the policy schema into the files admins deploy: ADMX and ADML for Group
 * Policy and Intune, a sample .mobileconfig for macOS, a sample policies.json for
 * Linux. `scripts/generate-desktop-policies.mjs` writes them to desktop-policies/;
 * a test fails when what's committed differs from what this produces.
 */

import {
  POLICY_BUNDLE_ID,
  POLICY_CATEGORIES,
  POLICY_KEYS,
  POLICY_LINUX_FILE,
  POLICY_RECOMMENDED_SUBKEY,
  POLICY_REGISTRY_ROOT,
  POLICY_SCHEMA,
  type PolicyCategory,
  type PolicyDefinition,
  type PolicyKey,
  type PolicyText,
} from './policy-schema';

type Language = keyof PolicyText;

const NAMESPACE = 'http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions';
const SUPPORTED = 'SUPPORTED_Bulwark_Desktop';
const ROOT_CATEGORY = 'Bulwark';
const FORCED_CATEGORY = 'Bulwark_Desktop';
const RECOMMENDED_CATEGORY = 'Bulwark_Desktop_Recommended';

const CATEGORY_IDS = Object.keys(POLICY_CATEGORIES) as PolicyCategory[];

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);
}

function categoryId(category: PolicyCategory): string {
  return `Bulwark_Desktop_${category}`;
}

/** A policy appears twice in the tree: forced, and as a default the user can change. */
function policyVariants(key: PolicyKey): { recommended: boolean; id: string }[] {
  return POLICY_SCHEMA[key].forcedOnly
    ? [{ recommended: false, id: key }]
    : [{ recommended: false, id: key }, { recommended: true, id: `${key}_Recommended` }];
}

function policyElement(key: PolicyKey, recommended: boolean, id: string): string {
  const definition = POLICY_SCHEMA[key];
  const root = recommended ? `${POLICY_REGISTRY_ROOT}\\${POLICY_RECOMMENDED_SUBKEY}` : POLICY_REGISTRY_ROOT;
  const parent = recommended ? RECOMMENDED_CATEGORY : categoryId(definition.category);
  const common = `class="Both" displayName="$(string.${key})" explainText="$(string.${key}_Explain)"`;
  const head = `    <parentCategory ref="${parent}"/>\n    <supportedOn ref="${SUPPORTED}"/>`;
  switch (definition.type) {
    case 'boolean':
      return [
        `  <policy name="${id}" ${common} key="${xml(root)}" valueName="${key}">`,
        head,
        '    <enabledValue><decimal value="1"/></enabledValue>',
        '    <disabledValue><decimal value="0"/></disabledValue>',
        '  </policy>',
      ].join('\n');
    case 'integer':
      return [
        `  <policy name="${id}" ${common} presentation="$(presentation.${id})" key="${xml(root)}">`,
        head,
        '    <elements>',
        `      <decimal id="${id}_Value" valueName="${key}" required="true" minValue="${definition.min}" maxValue="${definition.max}"/>`,
        '    </elements>',
        '  </policy>',
      ].join('\n');
    case 'enum':
      return [
        `  <policy name="${id}" ${common} presentation="$(presentation.${id})" key="${xml(root)}">`,
        head,
        '    <elements>',
        `      <enum id="${id}_Value" valueName="${key}" required="true">`,
        ...definition.values.map(
          (option) => `        <item displayName="$(string.${key}_${option.value})"><value><string>${xml(option.value)}</string></value></item>`,
        ),
        '      </enum>',
        '    </elements>',
        '  </policy>',
      ].join('\n');
    case 'string':
      return [
        `  <policy name="${id}" ${common} presentation="$(presentation.${id})" key="${xml(root)}">`,
        head,
        '    <elements>',
        `      <text id="${id}_Value" valueName="${key}" required="true" maxLength="${definition.maxLength}"/>`,
        '    </elements>',
        '  </policy>',
      ].join('\n');
    case 'list':
      // valuePrefix="" gives values named 1, 2, 3 in a subkey of the policy's name.
      return [
        `  <policy name="${id}" ${common} presentation="$(presentation.${id})" key="${xml(`${root}\\${key}`)}">`,
        head,
        '    <elements>',
        `      <list id="${id}_Value" valuePrefix=""/>`,
        '    </elements>',
        '  </policy>',
      ].join('\n');
  }
}

export function generateAdmx(): string {
  const categories = [
    `    <category name="${ROOT_CATEGORY}" displayName="$(string.Category_Bulwark)"/>`,
    `    <category name="${FORCED_CATEGORY}" displayName="$(string.Category_Desktop)"><parentCategory ref="${ROOT_CATEGORY}"/></category>`,
    `    <category name="${RECOMMENDED_CATEGORY}" displayName="$(string.Category_Recommended)"><parentCategory ref="${ROOT_CATEGORY}"/></category>`,
    ...CATEGORY_IDS.map(
      (category) => `    <category name="${categoryId(category)}" displayName="$(string.Category_${category})"><parentCategory ref="${FORCED_CATEGORY}"/></category>`,
    ),
  ];
  const policies = POLICY_KEYS.flatMap((key) => policyVariants(key).map(({ recommended, id }) => policyElement(key, recommended, id)));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated from lib/desktop/policy-schema.ts by scripts/generate-desktop-policies.mjs. Do not edit. -->',
    `<policyDefinitions xmlns="${NAMESPACE}" revision="1.0" schemaVersion="1.0">`,
    '  <policyNamespaces>',
    '    <target prefix="bulwark" namespace="Bulwark.Policies.Desktop"/>',
    '  </policyNamespaces>',
    '  <resources minRequiredRevision="1.0"/>',
    '  <supportedOn>',
    '    <definitions>',
    `      <definition name="${SUPPORTED}" displayName="$(string.${SUPPORTED})"/>`,
    '    </definitions>',
    '  </supportedOn>',
    '  <categories>',
    ...categories,
    '  </categories>',
    '  <policies>',
    ...policies,
    '  </policies>',
    '</policyDefinitions>',
    '',
  ].join('\n');
}

const INTRO: PolicyText = {
  en: 'Settings for the Bulwark desktop app.',
  de: 'Einstellungen für die Bulwark-Desktop-App.',
};
const SUPPORTED_TEXT: PolicyText = { en: 'All versions of Bulwark Desktop', de: 'Alle Versionen von Bulwark Desktop' };
const RECOMMENDED_TEXT: PolicyText = { en: 'Bulwark Desktop: defaults users can change', de: 'Bulwark Desktop: Standardwerte, die Benutzer ändern können' };

function presentationFor(key: PolicyKey, id: string, language: Language): string | null {
  const definition: PolicyDefinition = POLICY_SCHEMA[key];
  const refId = `${id}_Value`;
  switch (definition.type) {
    case 'boolean':
      return null;
    case 'integer':
      return `      <presentation id="${id}"><decimalTextBox refId="${refId}" defaultValue="${definition.sample}">${xml(definition.unit[language])}</decimalTextBox></presentation>`;
    case 'enum':
      return `      <presentation id="${id}"><dropdownList refId="${refId}" noSort="true" defaultItem="0">${xml(definition.title[language])}</dropdownList></presentation>`;
    case 'string':
      return `      <presentation id="${id}"><textBox refId="${refId}"><label>${xml(definition.label[language])}</label></textBox></presentation>`;
    case 'list':
      return `      <presentation id="${id}"><listBox refId="${refId}">${xml(definition.label[language])}</listBox></presentation>`;
  }
}

export function generateAdml(language: Language): string {
  const strings: [string, string][] = [
    ['Category_Bulwark', 'Bulwark'],
    ['Category_Desktop', 'Bulwark Desktop'],
    ['Category_Recommended', RECOMMENDED_TEXT[language]],
    [SUPPORTED, SUPPORTED_TEXT[language]],
    ...CATEGORY_IDS.map((category): [string, string] => [`Category_${category}`, POLICY_CATEGORIES[category][language]]),
  ];
  for (const key of POLICY_KEYS) {
    const definition = POLICY_SCHEMA[key];
    strings.push([key, definition.title[language]], [`${key}_Explain`, definition.description[language]]);
    if (definition.type === 'enum') {
      for (const option of definition.values) strings.push([`${key}_${option.value}`, option.title[language]]);
    }
  }
  const presentations = POLICY_KEYS.flatMap((key) =>
    policyVariants(key)
      .map(({ id }) => presentationFor(key, id, language))
      .filter((line): line is string => line !== null),
  );
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated from lib/desktop/policy-schema.ts by scripts/generate-desktop-policies.mjs. Do not edit. -->',
    `<policyDefinitionResources xmlns="${NAMESPACE}" revision="1.0" schemaVersion="1.0">`,
    '  <displayName>Bulwark Desktop</displayName>',
    `  <description>${xml(INTRO[language])}</description>`,
    '  <resources>',
    '    <stringTable>',
    ...strings.map(([id, text]) => `      <string id="${xml(id)}">${xml(text)}</string>`),
    '    </stringTable>',
    '    <presentationTable>',
    ...presentations,
    '    </presentationTable>',
    '  </resources>',
    '</policyDefinitionResources>',
    '',
  ].join('\n');
}

/** A stable UUID, so generating twice gives the same file. Not a secret, only an identifier. */
function stableUuid(name: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const char of `bulwark-policy:${name}`) {
    const code = char.charCodeAt(0);
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b + code, 2166136261) >>> 0;
  }
  const hex = (value: number) => value.toString(16).padStart(8, '0');
  const all = `${hex(a)}${hex(b)}${hex(Math.imul(a, b) >>> 0)}${hex((a ^ b) >>> 0)}`;
  return `${all.slice(0, 8)}-${all.slice(8, 12)}-4${all.slice(13, 16)}-8${all.slice(17, 20)}-${all.slice(20, 32)}`.toUpperCase();
}

function plistValue(value: unknown, indent: string): string {
  if (typeof value === 'boolean') return `${indent}<${value}/>`;
  if (typeof value === 'number') return `${indent}<integer>${value}</integer>`;
  if (typeof value === 'string') return `${indent}<string>${xml(value)}</string>`;
  if (Array.isArray(value)) {
    return [`${indent}<array>`, ...value.map((item) => plistValue(item, `${indent}  `)), `${indent}</array>`].join('\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return [
    `${indent}<dict>`,
    ...entries.flatMap(([key, item]) => [`${indent}  <key>${xml(key)}</key>`, plistValue(item, `${indent}  `)]),
    `${indent}</dict>`,
  ].join('\n');
}

/** What the samples set. A sample that would delete mail when deployed as it is doesn't set the nonce. */
function sampleValues(): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) {
    if (key === 'WipeOfflineData') continue;
    const definition = POLICY_SCHEMA[key];
    sample[key] = definition.sample;
  }
  return sample;
}

export function generateMobileconfig(): string {
  const { InstanceUrl, UpdateChannel, ...forced } = sampleValues();
  const payload = {
    PayloadType: POLICY_BUNDLE_ID,
    PayloadVersion: 1,
    PayloadIdentifier: `${POLICY_BUNDLE_ID}.policy.settings`,
    PayloadUUID: stableUuid('settings'),
    PayloadEnabled: true,
    PayloadDisplayName: 'Bulwark settings',
    InstanceUrl,
    ...forced,
    // Not forced: a default the user can change.
    Recommended: { UpdateChannel },
  };
  const profile = {
    PayloadContent: [payload],
    PayloadType: 'Configuration',
    PayloadVersion: 1,
    PayloadIdentifier: `${POLICY_BUNDLE_ID}.policy`,
    PayloadUUID: stableUuid('profile'),
    PayloadDisplayName: 'Bulwark Desktop',
    PayloadDescription: 'A sample profile. Remove what you do not want to set, and change the rest.',
    PayloadScope: 'System',
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Generated from lib/desktop/policy-schema.ts by scripts/generate-desktop-policies.mjs. Do not edit. -->',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(profile, ''),
    '</plist>',
    '',
  ].join('\n');
}

export function generatePoliciesJson(): string {
  const { UpdateChannel, ...forced } = sampleValues();
  return `${JSON.stringify({ ...forced, Recommended: { UpdateChannel } }, null, 2)}\n`;
}

/** Relative path under desktop-policies/ to its content. */
export function generatePolicyFiles(): Record<string, string> {
  return {
    'Bulwark.admx': generateAdmx(),
    'en-US/Bulwark.adml': generateAdml('en'),
    'de-DE/Bulwark.adml': generateAdml('de'),
    [`${POLICY_BUNDLE_ID}.mobileconfig`]: generateMobileconfig(),
    'policies.json': generatePoliciesJson(),
    'README.txt': [
      'Generated by scripts/generate-desktop-policies.mjs. Do not edit these files.',
      '',
      'Windows: copy Bulwark.admx to %SystemRoot%\\PolicyDefinitions, and the en-US and',
      'de-DE folders next to it (or to the central store in SYSVOL). In Intune, import',
      'Bulwark.admx and en-US\\Bulwark.adml.',
      '',
      `macOS: ${POLICY_BUNDLE_ID}.mobileconfig is a sample. Change it and deploy it by MDM.`,
      '',
      `Linux: policies.json is a sample for ${POLICY_LINUX_FILE}. It must be owned by root`,
      'and writable only by root (mode 644). Otherwise the app refuses to start.',
      '',
      'Limits: these settings stop people from changing them inside the app. The app is',
      'not signed yet, so someone who can write to its folder or run their own copy can',
      'patch it. For a hard guarantee, also limit what may run with AppLocker or WDAC,',
      'and install per machine with the MSI so standard users cannot write to the folder.',
      '',
    ].join('\n'),
  };
}
