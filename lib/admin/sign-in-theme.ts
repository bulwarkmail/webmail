import { getThemeRegistry } from './plugin-registry';
import type { SettingsPolicy, SignInTheme } from './types';

/**
 * The admin theme a visitor who is not signed in gets on the sign-in page
 * (#1846): the theme switched on for everyone, else the default theme, when
 * it is an enabled admin theme. Null when neither is (a built-in default is
 * in every browser already). The full theme list stays behind a session
 * (/api/plugins); this names one theme, whose CSS is served to anyone.
 */
export async function signInThemeFor(policy: SettingsPolicy): Promise<SignInTheme | null> {
  const { themes } = await getThemeRegistry();
  const enabled = themes.filter((theme) => theme.enabled);
  const byId = (id: unknown) => enabled.find((theme) => theme.id === id);
  const forced = (policy.forceEnabledThemes ?? []).map(byId).find(Boolean)
    ?? enabled.find((theme) => theme.forceEnabled);
  const theme = forced ?? byId(policy.themePolicy?.defaultThemeId);
  if (!theme) return null;
  return {
    id: theme.id,
    name: theme.name,
    version: theme.version,
    author: theme.author,
    description: theme.description,
    variants: theme.variants,
    forceEnabled: theme.forceEnabled || false,
    hasSkin: theme.hasSkin || false,
    contentHash: theme.contentHash,
  };
}
