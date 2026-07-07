/**
 * By default the stack is left running after the suite so re-runs are fast and
 * the state can be inspected (webmail on :3000, Stalwart admin on :8025).
 * Set IT_TEARDOWN=1 to tear the containers (and volumes) down instead.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const INTEGRATION_DIR = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(INTEGRATION_DIR, 'docker-compose.yml');
const ENV_FILE = path.join(INTEGRATION_DIR, '.env');

export default async function globalTeardown(): Promise<void> {
  if (process.env.IT_TEARDOWN !== '1' || process.env.IT_NO_DOCKER === '1') {
    console.log('[global-teardown] leaving stack up (set IT_TEARDOWN=1 to remove it)');
    return;
  }
  console.log('[global-teardown] docker compose down -v');
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE, 'down', '-v'], {
    cwd: INTEGRATION_DIR,
    stdio: 'inherit',
  });
}
