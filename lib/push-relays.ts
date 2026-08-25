// Web Push relay choices. Users pick from a list the admin curates - only an
// admin can introduce a relay URL, so a user can never point their push
// registration (which carries their address label) at an arbitrary host.

import type { PushRelayOption, SettingsPolicy } from '@/lib/admin/types';

// Hosted relay so self-hosters don't need their own VAPID + Firebase setup.
// The built-in entry can be repointed at build time via NEXT_PUBLIC_PUSH_RELAY_URL.
export const DEFAULT_RELAY_BASE_URL =
  process.env.NEXT_PUBLIC_PUSH_RELAY_URL || 'https://notifications.relay.bulwarkmail.org';

export type PushRelayPolicy = Partial<
  Pick<SettingsPolicy, 'pushRelays' | 'pushRelayUrl' | 'pushRelayUrlLocked'>
>;

export function normalizeRelayUrl(url: string | null | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '');
}

export function isValidRelayUrl(url: string | null | undefined): boolean {
  return /^https?:\/\/[^\s/]+/i.test(normalizeRelayUrl(url));
}

/** Falls back to the host so an admin entry without a label is still readable. */
export function relayDisplayLabel(option: PushRelayOption): string {
  const label = option.label?.trim();
  if (label) return label;
  try {
    return new URL(option.url).host;
  } catch {
    return option.url;
  }
}

/**
 * The relays a user may choose between: the built-in default first, then the
 * admin-configured list. Invalid and duplicate URLs are dropped.
 */
export function resolvePushRelayOptions(policy: PushRelayPolicy | undefined | null): PushRelayOption[] {
  const options: PushRelayOption[] = [];
  const seen = new Set<string>();

  const add = (label: string | undefined, rawUrl: string | undefined) => {
    const url = normalizeRelayUrl(rawUrl);
    if (!isValidRelayUrl(url) || seen.has(url)) return;
    seen.add(url);
    options.push({ label: relayDisplayLabel({ label: label ?? '', url }), url });
  };

  add(undefined, DEFAULT_RELAY_BASE_URL);
  for (const relay of policy?.pushRelays ?? []) add(relay?.label, relay?.url);
  // Deployments configured before the relay list existed carry a single custom
  // URL. Keep it selectable so their users are not silently moved off it.
  add(undefined, policy?.pushRelayUrl);

  return options;
}

/** The relay used when the user has not picked one (or their pick is gone). */
export function resolveDefaultRelayUrl(policy: PushRelayPolicy | undefined | null): string {
  const configured = normalizeRelayUrl(policy?.pushRelayUrl);
  return isValidRelayUrl(configured) ? configured : normalizeRelayUrl(DEFAULT_RELAY_BASE_URL);
}

/**
 * The relay to actually register with: the user's pick when the policy still
 * offers it and the admin has not locked the choice, otherwise the default.
 */
export function resolveActiveRelayUrl(
  policy: PushRelayPolicy | undefined | null,
  userSelection: string | null | undefined,
): string {
  const fallback = resolveDefaultRelayUrl(policy);
  if (policy?.pushRelayUrlLocked) return fallback;
  const selected = normalizeRelayUrl(userSelection);
  if (!selected) return fallback;
  return resolvePushRelayOptions(policy).some((option) => option.url === selected)
    ? selected
    : fallback;
}
