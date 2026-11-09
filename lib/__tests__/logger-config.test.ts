// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configManager } from '@/lib/admin/config-manager';
import { logger } from '@/lib/logger';

let dir: string;
let out: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-logger-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('LOG_LEVEL', 'info');
  vi.stubEnv('LOG_FORMAT', 'text');
  out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('logger settings from the admin config', () => {
  it('uses the log level and format saved by the setup wizard', async () => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ logLevel: 'debug', logFormat: 'json' }), 'utf-8');
    await configManager.reload();
    out.mockClear();

    logger.debug('hello', { a: 1 });

    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ level: 'debug', message: 'hello', a: 1 });
  });

  it('picks up a change saved in the admin console without a restart', async () => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({}), 'utf-8');
    await configManager.reload();
    out.mockClear();
    logger.info('before');
    expect(out).toHaveBeenCalledTimes(1);

    await configManager.setAdminConfig({ logLevel: 'error' });
    out.mockClear();
    logger.info('after');
    expect(out).not.toHaveBeenCalled();

    await configManager.removeAdminOverride('logLevel');
    out.mockClear();
    logger.info('reverted');
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('falls back to LOG_LEVEL when the admin config has no value', async () => {
    vi.stubEnv('LOG_LEVEL', 'warn');
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({}), 'utf-8');
    await configManager.reload();
    out.mockClear();
    logger.info('quiet');
    expect(out).not.toHaveBeenCalled();
  });
});
