import { compareVersions } from '@/lib/version-compare';

interface Row {
  version: string;
  channel: 'stable' | 'beta';
  yanked: unknown;
}

/** compareVersions, with a release above its pre-releases (1.3.0-beta.1 < 1.3.0). */
function compare(a: string, b: string): number {
  const d = compareVersions(a, b);
  if (d !== 0) return d;
  const pa = a.split('+')[0].split('-').slice(1).join('-');
  const pb = b.split('+')[0].split('-').slice(1).join('-');
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  return pa.localeCompare(pb, 'en', { numeric: true });
}

/**
 * The versions whose notes matter when going from `installed` to `target`,
 * newest first. Going up: the versions above the installed one up to the
 * target, what the update brings. Going down: the installed version down to
 * just above the target, what going back undoes. Withdrawn versions are left
 * out unless installed, and betas unless the target is one or the channel is
 * beta.
 */
export function versionsBetween<T extends Row>(versions: T[], installed: string, target: string, channel: 'stable' | 'beta'): T[] {
  const [low, high] = compare(target, installed) > 0 ? [installed, target] : [target, installed];
  const betas = channel === 'beta' || target.includes('-');
  return versions
    .filter((v) => (!v.yanked || v.version === installed) && (v.channel !== 'beta' || betas)
      && compare(v.version, low) > 0 && compare(v.version, high) <= 0)
    .sort((a, b) => compare(b.version, a.version));
}
