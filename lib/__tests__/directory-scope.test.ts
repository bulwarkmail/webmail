import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Principal } from '@/lib/jmap/types';
import { usePolicyStore } from '@/stores/policy-store';
import { loadScopedPrincipalDirectory } from '../directory-scope';

const person = (id: string, email: string | null) =>
  ({ id, type: 'individual', name: email ?? id, description: null, email }) as unknown as Principal;

const LISTING = [
  person('me', 'me@example.org'),
  person('ana', 'ana@example.org'),
  person('bob', 'bob@example.net'),
  person('cy', 'cy@example.com'),
  person('noreply', 'NoReply@example.org'),
  person('room', null),
];

function makeClient(username: string, identities: string[] = [], accountId = 'me') {
  return {
    supportsPrincipals: () => true,
    getUsername: () => username,
    getAccountId: () => accountId,
    listPrincipals: vi.fn(async () => ({ principals: LISTING, status: 'ok' as const })),
    getPrincipals: vi.fn(async () => LISTING),
    getIdentities: vi.fn(async () => identities.map((email, i) => ({ id: `i${i}`, name: '', email }))),
  };
}

const initialPolicy = usePolicyStore.getState();

function setRules(patch: Partial<SettingsPolicy>) {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, ...patch }, loaded: true, partial: false });
}

async function shown(client: ReturnType<typeof makeClient>): Promise<Array<string | null | undefined>> {
  return (await loadScopedPrincipalDirectory(client as unknown as IJMAPClient)).principals.map((p) => p.email);
}

afterEach(() => {
  usePolicyStore.setState(initialPolicy, true);
});

describe('the directory rules of the admin policy', () => {
  it('leave the listing whole without rules and ask for no identities', async () => {
    setRules({});
    const client = makeClient('me@example.org');
    expect(await shown(client)).toHaveLength(LISTING.length);
    expect(client.getIdentities).not.toHaveBeenCalled();
  });

  it("keep the domains of the account's addresses, aliases included", async () => {
    setRules({ directorySameDomainOnly: true });
    expect(await shown(makeClient('me@example.org', ['me@example.org', 'me@example.net'])))
      .toEqual(['me@example.org', 'ana@example.org', 'bob@example.net', 'NoReply@example.org']);
  });

  it("ask the account's server for its identities once and keep them", async () => {
    setRules({ directorySameDomainOnly: true });
    const client = makeClient('me@example.org', ['me@example.com']);
    expect(await shown(client)).toEqual(['me@example.org', 'ana@example.org', 'cy@example.com', 'NoReply@example.org']);
    await shown(client);
    expect(client.getIdentities).toHaveBeenCalledTimes(1);
  });

  // Server routes import the contact store, which imports this module; the
  // auth store pulls modules that only run in the browser (next build fails).
  it('import no store that only runs in the browser', () => {
    expect(readFileSync(join(process.cwd(), 'lib/directory-scope.ts'), 'utf8')).not.toMatch(/stores\/auth-store/);
  });

  it('decide by the account on a master login', async () => {
    setRules({ directorySameDomainOnly: true });
    expect(await shown(makeClient('bob@example.net%admin@example.com', [], 'bob'))).toEqual(['bob@example.net']);
  });

  it('hide the listed account names in every domain', async () => {
    setRules({ directoryHiddenLocalparts: ['noreply', 'cy'] });
    expect(await shown(makeClient('me@example.org'))).toEqual(['me@example.org', 'ana@example.org', 'bob@example.net', null]);
  });

  it('drop an entry without an address under the domain rule', async () => {
    setRules({ directorySameDomainOnly: true });
    expect(await shown(makeClient('me@example.org'))).not.toContain(null);
  });

  it('keep no one under the domain rule when no address of the account has a domain', async () => {
    setRules({ directorySameDomainOnly: true });
    expect(await shown(makeClient('me', [], 'nobody'))).toEqual([]);
  });

  it('take the fields as Lite reads them from policy.json, unsanitized', async () => {
    setRules({ directoryHiddenLocalparts: [' NoReply ', 42, ''] as unknown as string[] });
    expect(await shown(makeClient('me@example.org'))).not.toContain('NoReply@example.org');
    setRules({ directorySameDomainOnly: 'yes' as unknown as boolean });
    expect(await shown(makeClient('me@example.org'))).toHaveLength(LISTING.length);
  });

  it('read the full policy first when only the public part is there', async () => {
    usePolicyStore.setState({
      policy: { ...DEFAULT_POLICY },
      loaded: true,
      partial: true,
      refreshIfPartial: async () => usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, directorySameDomainOnly: true }, partial: false }),
    });
    expect(await shown(makeClient('me@example.org'))).toEqual(['me@example.org', 'ana@example.org', 'NoReply@example.org']);
  });

  it('apply rules set after the listing was loaded, without loading it again', async () => {
    setRules({});
    const client = makeClient('me@example.org');
    expect(await shown(client)).toHaveLength(LISTING.length);
    setRules({ directorySameDomainOnly: true });
    expect(await shown(client)).toEqual(['me@example.org', 'ana@example.org', 'NoReply@example.org']);
    expect(client.listPrincipals).toHaveBeenCalledTimes(1);
  });

  it('report a listing it cannot scope as failed, not whole', async () => {
    setRules({ directorySameDomainOnly: true });
    const client = makeClient('me@example.org');
    client.getUsername = () => { throw new Error('no session'); };
    expect(await loadScopedPrincipalDirectory(client as unknown as IJMAPClient)).toEqual({ principals: [], status: 'error' });
  });
});

describe('every list of the server accounts', () => {
  // Reading the directory lists accounts. Each place that does applies the
  // policy's rules (loadScopedPrincipalDirectory or directoryScopeFor) or
  // shows no one; a new one has to be added here with its reason.
  const ALLOWED: Record<string, string> = {
    'lib/jmap/client.ts': 'defines the calls',
    'lib/jmap/client-interface.ts': 'declares the calls',
    'lib/demo/demo-client.ts': 'the demo server',
    'lib/jmap/principal-directory.ts': 'the shared listing the rules narrow',
    'lib/directory-scope.ts': 'applies the rules',
    'lib/jmap/principal-cache.ts': 'names sharees already granted, lists no one',
    'lib/plugin-sandbox/host-api-account.ts': 'applies the rules itself',
  };

  it('goes through the directory rules', () => {
    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const file = relative(root, path).split('\\').join('/');
          const source = readFileSync(path, 'utf8');
          if (!(file in ALLOWED) && /\bloadPrincipalDirectory\b|\.listPrincipals\(|\.getPrincipals\(/.test(source)) offenders.push(file);
        }
      }
    };
    for (const dir of ['app', 'components', 'hooks', 'lib', 'stores']) walk(join(root, dir));
    expect(offenders).toEqual([]);
  });
});
