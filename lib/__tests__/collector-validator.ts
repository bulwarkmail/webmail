// Not a test: loads the collector's real validator for the tests that check against it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CollectorValidator {
  validate(input: unknown): { schema: string; build: string | null; platform: string; version: string; os_family: string; node_version: string | null } | null;
  validateErrorBatch(input: unknown): { errors: { name: string; count: string; days: number; version: string; frames: unknown[] }[] } | null;
}

/**
 * The validator on the branch the desktop app ships against, read from git so it doesn't
 * matter what the dashboard checkout has out. Null where there's no dashboard repo (CI).
 */
export async function loadCollectorValidator(): Promise<CollectorValidator | null> {
  const repo = process.env.BULWARK_DASHBOARD_DIR ?? 'C:/Users/info/Downloads/jmap-webmail/repos/dashboard';
  const ref = process.env.BULWARK_DASHBOARD_REF ?? 'feat/desktop-platform';
  if (!existsSync(repo)) return null;
  const shown = spawnSync('git', ['-C', repo, 'show', `${ref}:telemetry-collector/src/validate.ts`], { encoding: 'utf8' });
  if (shown.status !== 0) throw new Error(`no validator at ${ref}: ${shown.stderr}`);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'bw-validator-')), 'validate.ts');
  writeFileSync(file, shown.stdout);
  return await import(/* @vite-ignore */ pathToFileURL(file).href) as CollectorValidator;
}
