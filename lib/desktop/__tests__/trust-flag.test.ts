// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { desktopBuildFlag } from '../../../scripts/desktop-build-flag.mjs';

const ROOT = path.resolve(__dirname, '../../..');
const TRUST_KEY = Symbol.for('bulwark.desktop.trustedJmapOrigins');
const PRIVATE_SERVER = 'http://192.168.1.5:8080';

type Holder = Record<symbol, ReadonlySet<string> | undefined>;

function trust(...origins: string[]) {
  (globalThis as unknown as Holder)[TRUST_KEY] = new Set(origins);
}

async function loadResolver() {
  vi.resetModules();
  return (await import('@/lib/admin/jmap-servers')).resolveTrustedJmapUrl;
}

beforeEach(() => {
  delete (globalThis as unknown as Holder)[TRUST_KEY];
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as unknown as Holder)[TRUST_KEY];
});

describe('the trusted set, server build', () => {
  it('refuses a private URL even when the set holds it', async () => {
    trust('http://192.168.1.5:8080');
    const resolve = await loadResolver();
    expect(resolve(PRIVATE_SERVER, '', [])).toBeNull();
  });
});

describe('the trusted set, desktop build', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
  });

  it('accepts a server main approved', async () => {
    trust('http://192.168.1.5:8080');
    const resolve = await loadResolver();
    expect(resolve(`${PRIVATE_SERVER}/`, '', [])).toBe(PRIVATE_SERVER);
  });

  it('does not trust everything: another private server stays out', async () => {
    trust('http://192.168.1.5:8080');
    const resolve = await loadResolver();
    expect(resolve('http://192.168.1.6:8080', '', [])).toBeNull();
    expect(resolve('http://192.168.1.5:9999', '', [])).toBeNull();
    expect(resolve('http://169.254.169.254', '', [])).toBeNull();
  });

  it('trusts nothing before main has sent a set', async () => {
    const resolve = await loadResolver();
    expect(resolve(PRIVATE_SERVER, '', [])).toBeNull();
  });

  it('ignores a URL with credentials in it', async () => {
    trust('http://192.168.1.5:8080');
    const resolve = await loadResolver();
    expect(resolve('http://a:b@192.168.1.5:8080', '', [])).toBeNull();
  });
});

describe('the flag is fixed at build time', () => {
  /** Compiles lib/desktop/flag.ts the way next.config.ts `env` does and runs it. */
  async function flagOfBuild(buildEnv: NodeJS.ProcessEnv, runtimeEnv: NodeJS.ProcessEnv): Promise<boolean> {
    const result = await build({
      entryPoints: [path.join(ROOT, 'lib/desktop/flag.ts')],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      define: { 'process.env.NEXT_PUBLIC_BULWARK_DESKTOP': JSON.stringify(desktopBuildFlag(buildEnv)) },
    });
    const run = new Function('module', 'exports', 'process', result.outputFiles[0].text);
    const module = { exports: {} as { IS_DESKTOP_BUILD?: boolean } };
    run(module, module.exports, { env: runtimeEnv });
    return module.exports.IS_DESKTOP_BUILD === true;
  }

  it('a runtime env var cannot switch a server build on', async () => {
    expect(await flagOfBuild({}, { NEXT_PUBLIC_BULWARK_DESKTOP: '1' })).toBe(false);
  });

  it('a desktop build is on without any runtime env var', async () => {
    expect(await flagOfBuild({ NEXT_PUBLIC_BULWARK_DESKTOP: '1' }, {})).toBe(true);
  });

  it('next.config.ts always inlines the flag, so an unset one is no runtime read', () => {
    const config = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');
    expect(config).toMatch(/NEXT_PUBLIC_BULWARK_DESKTOP: desktopBuildFlag\(\)/);
    expect(desktopBuildFlag({})).toBe('');
  });

  it('flag.ts reads the variable in the one form the compiler replaces', () => {
    const source = readFileSync(path.join(ROOT, 'lib/desktop/flag.ts'), 'utf8');
    expect(source).toContain("process.env.NEXT_PUBLIC_BULWARK_DESKTOP === '1'");
  });

  it('no image build sets it', () => {
    for (const file of ['Dockerfile', 'Dockerfile.lite']) {
      expect(readFileSync(path.join(ROOT, file), 'utf8')).not.toContain('NEXT_PUBLIC_BULWARK_DESKTOP');
    }
  });
});
