// Update-status payload returned by the version server. Mirrors
// repos/dashboard/version-server/src/registry.ts LookupResult.

export type UpdateSeverity = 'normal' | 'security' | 'deprecated' | 'none' | 'unknown';

export interface UpdateStatus {
  schema: 1;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  severity: UpdateSeverity;
  url: string | null;
  advisory: string | null;
  checkedAt: string;
}

export interface VersionCheckStateFile {
  endpoint: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextScheduledAt: string | null;
  status: UpdateStatus | null;
}

export const DEFAULT_VERSION_ENDPOINT = 'https://version.telemetry.bulwarkmail.org/';
