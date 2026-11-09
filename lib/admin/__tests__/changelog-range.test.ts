import { describe, expect, it } from 'vitest';
import { versionsBetween } from '../changelog-range';

const v = (version: string, yanked: unknown = null) => ({ version, channel: version.includes('-') ? 'beta' as const : 'stable' as const, yanked });
const ALL = [v('1.4.0'), v('1.3.0'), v('1.3.0-beta.1'), v('1.2.0', { at: 'x' }), v('1.1.0'), v('1.0.0')];
const versions = (installed: string, target: string, channel: 'stable' | 'beta' = 'stable') =>
  versionsBetween(ALL, installed, target, channel).map((r) => r.version);

describe('versionsBetween', () => {
  it('lists what an update brings, newest first, without withdrawn versions', () => {
    expect(versions('1.0.0', '1.3.0')).toEqual(['1.3.0', '1.1.0']);
  });

  it('lists what going back undoes: the installed version down to just above the target', () => {
    expect(versions('1.4.0', '1.1.0')).toEqual(['1.4.0', '1.3.0']);
  });

  it('keeps a withdrawn version that is installed', () => {
    expect(versions('1.2.0', '1.0.0')).toEqual(['1.2.0', '1.1.0']);
  });

  it('shows betas on the beta channel or when going to a beta, ordered below their release', () => {
    expect(versions('1.1.0', '1.3.0', 'beta')).toEqual(['1.3.0', '1.3.0-beta.1']);
    expect(versions('1.1.0', '1.3.0-beta.1')).toEqual(['1.3.0-beta.1']);
  });
});
