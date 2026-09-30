import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readImpersonationConfig } from '@/lib/impersonation/master-config';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-impersonation-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function secretFile(name: string, value: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `${value}\n`);
  return file;
}

describe('readImpersonationConfig', () => {
  it('reads the secrets from *_FILE when the plain variables are unset', async () => {
    vi.stubEnv('BULWARK_JWT_AUTH_SECRET_FILE', await secretFile('jwt', 'jwt-secret'));
    vi.stubEnv('BULWARK_STALWART_MASTER_USER_FILE', await secretFile('user', 'master'));
    vi.stubEnv('BULWARK_STALWART_MASTER_PASSWORD_FILE', await secretFile('pass', 'hunter2'));

    expect(readImpersonationConfig()).toMatchObject({
      jwtSecret: 'jwt-secret',
      masterUser: 'master',
      masterPassword: 'hunter2',
    });
  });

  it('falls back to *_FILE when a plain variable is set but empty', async () => {
    // What uncommenting `BULWARK_JWT_AUTH_SECRET=` in .env.example leaves behind.
    vi.stubEnv('BULWARK_JWT_AUTH_SECRET', '');
    vi.stubEnv('BULWARK_JWT_AUTH_SECRET_FILE', await secretFile('jwt', 'jwt-secret'));
    vi.stubEnv('BULWARK_STALWART_MASTER_USER', 'master');
    vi.stubEnv('BULWARK_STALWART_MASTER_PASSWORD', 'hunter2');

    expect(readImpersonationConfig()?.jwtSecret).toBe('jwt-secret');
  });

  it('prefers the plain variable over the file', async () => {
    vi.stubEnv('BULWARK_JWT_AUTH_SECRET', 'from-env');
    vi.stubEnv('BULWARK_JWT_AUTH_SECRET_FILE', await secretFile('jwt', 'from-file'));
    vi.stubEnv('BULWARK_STALWART_MASTER_USER', 'master');
    vi.stubEnv('BULWARK_STALWART_MASTER_PASSWORD', 'hunter2');

    expect(readImpersonationConfig()?.jwtSecret).toBe('from-env');
  });
});
