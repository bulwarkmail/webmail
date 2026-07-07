/**
 * Brings the integration stack up before the suite runs:
 *   1. fetch the arch-specific stalwart-cli (offline-friendly build input),
 *   2. ensure integration/.env exists (compose credentials),
 *   3. docker compose up -d --build --wait (Stalwart + webmail),
 *   4. block until Stalwart JMAP and the webmail health endpoint answer.
 *
 * Set IT_NO_DOCKER=1 to skip container management entirely (useful when the
 * stack is already running, e.g. during test authoring against `npm run dev`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { JMAP_URL, WEBMAIL_URL, ACCOUNTS, ACCOUNT_PASSWORD } from './helpers/config';

const INTEGRATION_DIR = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(INTEGRATION_DIR, 'docker-compose.yml');
const ENV_FILE = path.join(INTEGRATION_DIR, '.env');

function run(cmd: string, args: string[], cwd = INTEGRATION_DIR): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

async function waitFor(label: string, url: string, check: (r: Response) => boolean, timeoutMs = 240000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(`${ACCOUNTS.alice.email}:${ACCOUNT_PASSWORD}`).toString('base64') } });
      if (check(res)) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label} at ${url}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export default async function globalSetup(): Promise<void> {
  if (process.env.IT_NO_DOCKER === '1') {
    console.log('[global-setup] IT_NO_DOCKER=1 — skipping docker compose management');
  } else {
    console.log('[global-setup] fetching stalwart-cli');
    run('bash', [path.join(INTEGRATION_DIR, 'stalwart', 'prepare-stalwart-cli.sh')]);

    if (!existsSync(ENV_FILE)) {
      console.log('[global-setup] creating integration/.env from .env.example');
      copyFileSync(path.join(INTEGRATION_DIR, '.env.example'), ENV_FILE);
    }

    console.log('[global-setup] docker compose up -d --build --wait');
    run('docker', [
      'compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE,
      'up', '-d', '--build', '--wait', '--wait-timeout', '300',
    ]);
  }

  console.log('[global-setup] waiting for Stalwart JMAP');
  await waitFor('Stalwart JMAP', `${JMAP_URL}/jmap/session`, (r) => r.ok);

  console.log('[global-setup] waiting for webmail');
  await waitFor('webmail', `${WEBMAIL_URL}/api/health`, (r) => r.ok, 240000);

  console.log('[global-setup] stack ready');
}
