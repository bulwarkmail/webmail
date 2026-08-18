import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFilterStore } from '../filter-store';
import { generateScript } from '@/lib/sieve/generator';
import { filterHooks } from '@/lib/plugin-hooks';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const makeRule = (overrides: Partial<FilterRule> = {}): FilterRule => ({
  id: 'rule-1',
  name: 'ISO',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'iso.org' }],
  actions: [{ type: 'add_label', value: 'red' }],
  stopProcessing: false,
  ...overrides,
});

/** A client serving one active script, recording what gets written back. */
function makeClient(content: string, scriptsOverride?: { id: string; name: string; blobId: string; isActive: boolean }[]) {
  const updateSieveScript = vi.fn(
    async (_scriptId: string, _content: string, _activate?: boolean, _accountId?: string) => {},
  );
  const client = {
    supportsSieve: () => true,
    getSieveAccountId: () => 'primary',
    getSieveAccounts: () => [{ id: 'primary', name: 'Me', isPrimary: true }],
    getSieveCapabilities: () => null,
    getSieveScripts: async () => scriptsOverride ?? [
      { id: 'vac', name: 'vacation', blobId: 'bv', isActive: false },
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
    ],
    getSieveScriptContent: async () => content,
    updateSieveScript,
  };
  return { client: client as unknown as IJMAPClient, updateSieveScript };
}

describe('filter-store renameKeywordInFilters', () => {
  beforeEach(() => {
    useFilterStore.getState().clearState();
  });

  it('rewrites the tag in the active script and uploads it', async () => {
    const { client, updateSieveScript } = makeClient(generateScript([makeRule()]));

    const outcome = await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(outcome).toEqual({ changed: 1, unhandled: 0 });
    expect(updateSieveScript).toHaveBeenCalledTimes(1);
    const [scriptId, uploaded, activate, accountId] = updateSieveScript.mock.calls[0];
    expect(scriptId).toBe('s1');
    expect(activate).toBe(true);
    expect(accountId).toBe('primary');
    expect(uploaded).toContain('addflag "$label:iso";');
    expect(uploaded).not.toContain('$label:red');
  });

  it('rewrites the metadata block the visual editor reads back', async () => {
    const { client, updateSieveScript } = makeClient(generateScript([makeRule()]));

    await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    const uploaded = updateSieveScript.mock.calls[0][1];
    const metadata = uploaded.match(/@metadata:begin\n([\s\S]*)\n@metadata:end/)?.[1];
    expect(metadata).toBeDefined();
    const parsed = JSON.parse(metadata as string) as { rules: FilterRule[] };
    expect(parsed.rules[0].actions[0]).toEqual({ type: 'add_label', value: 'iso' });
  });

  it('writes nothing when no rule names the tag', async () => {
    const script = generateScript([makeRule({ actions: [{ type: 'add_label', value: 'blue' }] })]);
    const { client, updateSieveScript } = makeClient(script);

    const outcome = await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(outcome).toEqual({ changed: 0, unhandled: 0 });
    expect(updateSieveScript).not.toHaveBeenCalled();
  });

  it('leaves a hand-edited script alone and reports what it could not rewrite', async () => {
    const { client, updateSieveScript } = makeClient(
      '/* @metadata:begin\n{corrupt\n@metadata:end */\naddflag "$label:red";',
    );

    const outcome = await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(outcome).toEqual({ changed: 0, unhandled: 1 });
    expect(updateSieveScript).not.toHaveBeenCalled();
  });

  it('keeps an open filter view in step when it shows the same account', async () => {
    const { client } = makeClient(generateScript([makeRule()]));
    await useFilterStore.getState().fetchFilters(client);
    expect(useFilterStore.getState().rules[0].actions[0].value).toBe('red');

    await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(useFilterStore.getState().rules[0].actions[0].value).toBe('iso');
    expect(useFilterStore.getState().rawScript).toContain('$label:iso');
  });

  it('does not touch loaded state belonging to another account', async () => {
    const { client } = makeClient(generateScript([makeRule()]));
    useFilterStore.setState({ selectedAccountId: 'shared', rules: [makeRule({ id: 'other' })] });

    await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(useFilterStore.getState().rules[0].id).toBe('other');
    expect(useFilterStore.getState().rules[0].actions[0].value).toBe('red');
  });

  it('does nothing when the account has no script at all', async () => {
    const client = {
      supportsSieve: () => true,
      getSieveAccountId: () => 'primary',
      getSieveScripts: async () => [],
    } as unknown as IJMAPClient;

    const outcome = await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(outcome).toEqual({ changed: 0, unhandled: 0 });
  });

  it('leaves an inactive script alone rather than activating it by writing to it', async () => {
    const { client, updateSieveScript } = makeClient(generateScript([makeRule()]), [
      { id: 's1', name: 'filters', blobId: 'b1', isActive: false },
    ]);

    const outcome = await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(outcome).toEqual({ changed: 0, unhandled: 0 });
    expect(updateSieveScript).not.toHaveBeenCalled();
  });

  it('does nothing on a server without Sieve', async () => {
    const client = {
      supportsSieve: () => false,
      getSieveAccountId: () => 'primary',
      getSieveScripts: async () => {
        throw new Error('should not be called');
      },
    } as unknown as IJMAPClient;

    await expect(
      useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso'),
    ).resolves.toEqual({ changed: 0, unhandled: 0 });
  });

  it('reports a reference it could not rewrite alongside the ones it did', async () => {
    const script = `${generateScript([makeRule()])}\n# unmanaged\nif header :contains "X-Tag" "$label:red" {\n    keep;\n}\n`;
    const { client, updateSieveScript } = makeClient(script);

    const outcome = await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');

    expect(outcome.changed).toBe(1);
    expect(outcome.unhandled).toBe(1);
    expect(updateSieveScript).toHaveBeenCalledTimes(1);
  });

  it('counts what a plugin grafted back on as unhandled, since that is what gets written', async () => {
    const { client } = makeClient(generateScript([makeRule()]));
    const registration = filterHooks.onSieveScriptGenerate.register(
      'test-plugin',
      (script: string) => `# plugin section\nif true {\n    addflag "$label:red";\n}\n${script}`,
    );

    try {
      const outcome = await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');
      expect(outcome).toEqual({ changed: 1, unhandled: 1 });
    } finally {
      registration.dispose();
    }
  });

  it('runs the uploaded script through the plugin generate hook', async () => {
    const { client, updateSieveScript } = makeClient(generateScript([makeRule()]));
    const registration = filterHooks.onSieveScriptGenerate.register(
      'test-plugin',
      (script: string) => `# plugin section\n${script}`,
    );

    try {
      await useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso');
    } finally {
      registration.dispose();
    }

    expect(updateSieveScript.mock.calls[0][1]).toContain('# plugin section');
  });

  it('propagates a failed upload so the caller can warn', async () => {
    const { client } = makeClient(generateScript([makeRule()]));
    (client as unknown as { updateSieveScript: unknown }).updateSieveScript = vi.fn(async () => {
      throw new Error('over quota');
    });

    await expect(
      useFilterStore.getState().renameKeywordInFilters(client, 'red', 'iso'),
    ).rejects.toThrow('over quota');
  });
});
