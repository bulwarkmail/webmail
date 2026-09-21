/**
 * User settings an operator can govern from the admin Policy tab: lock or
 * hide the control (`policy.restrictions`) and pick the value new users start
 * with (`policy.defaults`). Shared by the admin UI, the policy sanitizer and
 * the client, so a key added here is governable everywhere at once.
 */
export type PolicySettingType = 'boolean' | 'enum' | 'number';

export interface PolicySettingDef {
  key: string;
  label: string;
  category: string;
  type: PolicySettingType;
  /** Values an enum setting may take; other values are dropped. */
  allowedValues?: string[];
}

export const POLICY_SETTINGS: PolicySettingDef[] = [
  { key: 'fontSize', label: 'Font Size', category: 'Appearance', type: 'enum', allowedValues: ['small', 'medium', 'large'] },
  { key: 'density', label: 'Density', category: 'Appearance', type: 'enum', allowedValues: ['compact', 'regular', 'spacious'] },
  { key: 'animationsEnabled', label: 'Animations', category: 'Appearance', type: 'boolean' },
  { key: 'markAsReadDelay', label: 'Mark as Read Delay', category: 'Email', type: 'number' },
  { key: 'deleteAction', label: 'Delete Action', category: 'Email', type: 'enum', allowedValues: ['trash', 'trash-and-read', 'permanent'] },
  { key: 'showPreview', label: 'Show Preview', category: 'Email', type: 'boolean' },
  { key: 'mailLayout', label: 'Mail Layout', category: 'Email', type: 'enum', allowedValues: ['split', 'focus', 'horizontal'] },
  { key: 'emailsPerPage', label: 'Emails Per Page', category: 'Email', type: 'number' },
  { key: 'externalContentPolicy', label: 'External Content Policy', category: 'Email', type: 'enum', allowedValues: ['allow', 'block', 'ask'] },
  { key: 'sendConfirmation', label: 'Send Confirmation', category: 'Composer', type: 'boolean' },
  { key: 'defaultReplyMode', label: 'Default Reply Mode', category: 'Composer', type: 'enum', allowedValues: ['reply', 'reply-all'] },
  { key: 'autoSelectReplyIdentity', label: 'Auto-select Reply Identity', category: 'Composer', type: 'boolean' },
  { key: 'replyIdentityMatch', label: 'Reply Identity Matching', category: 'Composer', type: 'enum', allowedValues: ['exact', 'domain'] },
  { key: 'plainTextMode', label: 'Plain Text Only', category: 'Composer', type: 'boolean' },
  { key: 'signaturePosition', label: 'Signature Position', category: 'Composer', type: 'enum', allowedValues: ['above_quote', 'below_quote'] },
  { key: 'signatureSeparatorEnabled', label: 'Signature Separator', category: 'Composer', type: 'boolean' },
  { key: 'sessionTimeout', label: 'Session Timeout', category: 'Privacy', type: 'number' },
  { key: 'emailNotificationsEnabled', label: 'Email Notifications', category: 'Notifications', type: 'boolean' },
  { key: 'calendarNotificationsEnabled', label: 'Calendar Notifications', category: 'Notifications', type: 'boolean' },
  { key: 'debugMode', label: 'Debug Mode', category: 'Advanced', type: 'boolean' },
];

const POLICY_SETTINGS_BY_KEY = new Map(POLICY_SETTINGS.map((def) => [def.key, def]));

/** True when `value` is one the setting can legitimately hold. */
export function isValidPolicySettingValue(def: PolicySettingDef, value: unknown): boolean {
  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'enum':
      return typeof value === 'string' && (def.allowedValues ?? []).includes(value);
  }
}

/**
 * Keep only defaults for governable settings with a value of the right shape.
 * policy.json can be hand-edited, so this runs on every policy load and save
 * rather than trusting the admin UI.
 */
export function sanitizePolicyDefaults(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = POLICY_SETTINGS_BY_KEY.get(key);
    if (def && isValidPolicySettingValue(def, value)) out[key] = value;
  }
  return out;
}
