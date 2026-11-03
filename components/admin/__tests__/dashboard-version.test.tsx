import { describe, expect, it } from 'vitest';
import { versionSummary } from '@/app/(main)/admin/_pages/dashboard';
import type { UpdateSeverity } from '@/lib/version-check/types';

function running(current: string, latest: string | null, updateAvailable: boolean, severity: UpdateSeverity) {
  return {
    current,
    status: { schema: 1 as const, current, latest, updateAvailable, severity, url: null, advisory: null, checkedAt: '2026-11-03T01:35:19.076Z' },
  };
}

describe('versionSummary (admin overview)', () => {
  it('does not offer an older version while the server has not seen the new release', () => {
    expect(versionSummary(running('1.20.0', '1.19.1', false, 'none'))).toEqual({ text: 'Up to date', tone: 'muted' });
  });

  it('does not offer the last stable release to a beta', () => {
    expect(versionSummary(running('1.21.0-beta.1', '1.20.0', false, 'none'))).toEqual({ text: 'Up to date', tone: 'muted' });
  });

  it('offers a newer version when the server says there is one', () => {
    expect(versionSummary(running('1.19.1', '1.20.0', true, 'normal'))).toEqual({ text: 'v1.20.0 available', tone: 'warning' });
  });

  it('marks security updates and deprecated versions as danger', () => {
    expect(versionSummary(running('1.19.1', '1.20.0', true, 'security')).tone).toBe('danger');
    expect(versionSummary(running('1.0.0', '1.20.0', true, 'deprecated')).tone).toBe('danger');
  });

  it('claims nothing for a version the server does not know', () => {
    expect(versionSummary(running('9.9.9-fork', '1.20.0', false, 'unknown'))).toEqual({ tone: 'muted' });
  });

  it('shows no line before the version has loaded', () => {
    expect(versionSummary(null)).toEqual({ tone: 'muted' });
  });
});
