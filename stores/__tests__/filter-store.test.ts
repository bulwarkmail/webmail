import { describe, it, expect, beforeEach } from 'vitest';
import { useFilterStore } from '../filter-store';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const makeRule = (overrides: Partial<FilterRule> = {}): FilterRule => ({
  id: 'rule-1',
  name: 'Test Rule',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'test@example.com' }],
  actions: [{ type: 'move', value: 'Archive' }],
  stopProcessing: false,
  ...overrides,
});

describe('filter-store', () => {
  beforeEach(() => {
    useFilterStore.getState().clearState();
  });

  describe('addRule', () => {
    it('should append a rule', () => {
      useFilterStore.getState().addRule(makeRule());
      expect(useFilterStore.getState().rules).toHaveLength(1);
      expect(useFilterStore.getState().rules[0].id).toBe('rule-1');
    });

    it('should not replace existing rules', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1' }));
      useFilterStore.getState().addRule(makeRule({ id: 'r2' }));
      expect(useFilterStore.getState().rules).toHaveLength(2);
    });
  });

  describe('updateRule', () => {
    it('should update matching rule', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1', name: 'Old' }));
      useFilterStore.getState().updateRule('r1', { name: 'New' });
      expect(useFilterStore.getState().rules[0].name).toBe('New');
    });

    it('should not modify other rules', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1', name: 'A' }));
      useFilterStore.getState().addRule(makeRule({ id: 'r2', name: 'B' }));
      useFilterStore.getState().updateRule('r1', { name: 'Updated' });
      expect(useFilterStore.getState().rules[1].name).toBe('B');
    });

    it('should no-op for non-existent rule', () => {
      useFilterStore.getState().addRule(makeRule());
      useFilterStore.getState().updateRule('nonexistent', { name: 'X' });
      expect(useFilterStore.getState().rules[0].name).toBe('Test Rule');
    });
  });

  describe('deleteRule', () => {
    it('should remove rule by id', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1' }));
      useFilterStore.getState().addRule(makeRule({ id: 'r2' }));
      useFilterStore.getState().deleteRule('r1');
      expect(useFilterStore.getState().rules).toHaveLength(1);
      expect(useFilterStore.getState().rules[0].id).toBe('r2');
    });

    it('should no-op for unknown id', () => {
      useFilterStore.getState().addRule(makeRule());
      useFilterStore.getState().deleteRule('unknown');
      expect(useFilterStore.getState().rules).toHaveLength(1);
    });
  });

  describe('toggleRule', () => {
    it('should toggle enabled to disabled', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1', enabled: true }));
      useFilterStore.getState().toggleRule('r1');
      expect(useFilterStore.getState().rules[0].enabled).toBe(false);
    });

    it('should toggle disabled to enabled', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1', enabled: false }));
      useFilterStore.getState().toggleRule('r1');
      expect(useFilterStore.getState().rules[0].enabled).toBe(true);
    });

    it('should not affect other rules', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1', enabled: true }));
      useFilterStore.getState().addRule(makeRule({ id: 'r2', enabled: true }));
      useFilterStore.getState().toggleRule('r1');
      expect(useFilterStore.getState().rules[1].enabled).toBe(true);
    });
  });

  describe('reorderRules', () => {
    it('should reorder rules by id array', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1', name: 'First' }));
      useFilterStore.getState().addRule(makeRule({ id: 'r2', name: 'Second' }));
      useFilterStore.getState().addRule(makeRule({ id: 'r3', name: 'Third' }));
      useFilterStore.getState().reorderRules(['r3', 'r1', 'r2']);
      const names = useFilterStore.getState().rules.map(r => r.name);
      expect(names).toEqual(['Third', 'First', 'Second']);
    });

    it('should filter out unknown ids', () => {
      useFilterStore.getState().addRule(makeRule({ id: 'r1' }));
      useFilterStore.getState().reorderRules(['r1', 'unknown']);
      expect(useFilterStore.getState().rules).toHaveLength(1);
    });
  });

  describe('setRawScript', () => {
    it('should update rawScript', () => {
      useFilterStore.getState().setRawScript('require ["fileinto"];');
      expect(useFilterStore.getState().rawScript).toBe('require ["fileinto"];');
    });
  });

  describe('resetToVisualBuilder', () => {
    it('should clear opaque state, rawScript, and rules', () => {
      useFilterStore.setState({ isOpaque: true, rawScript: 'some script', rules: [makeRule()] });
      useFilterStore.getState().resetToVisualBuilder();
      expect(useFilterStore.getState().isOpaque).toBe(false);
      expect(useFilterStore.getState().rawScript).toBe('');
      expect(useFilterStore.getState().rules).toEqual([]);
    });
  });

  describe('clearState', () => {
    it('should reset all state to defaults', () => {
      useFilterStore.setState({
        rules: [makeRule()],
        isLoading: true,
        isSaving: true,
        error: 'some error',
        isSupported: true,
        activeScriptId: 'script-1',
        isOpaque: true,
        rawScript: 'content',
      });
      useFilterStore.getState().clearState();
      const state = useFilterStore.getState();
      expect(state.rules).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.isSaving).toBe(false);
      expect(state.error).toBeNull();
      expect(state.isSupported).toBe(false);
      expect(state.activeScriptId).toBeNull();
      expect(state.isOpaque).toBe(false);
      expect(state.rawScript).toBe('');
    });
  });

  describe('fetchFilters', () => {
    it('parses external rules from scripts without metadata', async () => {
      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [{ id: 's1', name: 'main', blobId: 'b1', isActive: true }],
        getSieveScriptContent: async () => 'require ["fileinto"];\nif header :contains "From" "x" { fileinto "Y"; }',
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().isOpaque).toBe(false);
      expect(useFilterStore.getState().rules).toHaveLength(1);
      expect(useFilterStore.getState().rules[0].origin).toBe('external');
    });

    it('sets isOpaque for truly unparseable content', async () => {
      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [{ id: 's1', name: 'main', blobId: 'b1', isActive: true }],
        getSieveScriptContent: async () => '/* @metadata:begin\n{corrupt\n@metadata:end */',
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().isOpaque).toBe(true);
    });

    it('should parse rules from metadata-bearing script', async () => {
      const rules = [makeRule()];
      const { generateScript } = await import('@/lib/sieve/generator');
      const script = generateScript(rules);
      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [{ id: 's1', name: 'main', blobId: 'b1', isActive: true }],
        getSieveScriptContent: async () => script,
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().isOpaque).toBe(false);
      expect(useFilterStore.getState().rules).toEqual(rules);
    });

    it('should handle empty script list', async () => {
      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [],
        getSieveScriptContent: async () => '',
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().rules).toEqual([]);
      expect(useFilterStore.getState().activeScriptId).toBeNull();
    });

    it('should set error on failure', async () => {
      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => { throw new Error('Network error'); },
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().error).toBe('Network error');
      expect(useFilterStore.getState().isLoading).toBe(false);
    });
  });

  describe('saveFilters', () => {
    it('should call updateSieveScript with activate when activeScriptId exists', async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const mockClient = {
        updateSieveScript: async (...args: unknown[]) => { calls.push({ method: 'updateSieveScript', args }); },
        createSieveScript: async (...args: unknown[]) => { calls.push({ method: 'createSieveScript', args }); return { id: 'new-id' }; },
      };
      useFilterStore.setState({
        activeScriptId: 'existing-id',
        rules: [makeRule()],
        isOpaque: false,
      });
      await useFilterStore.getState().saveFilters(mockClient as unknown as IJMAPClient);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('updateSieveScript');
      expect(calls[0].args[0]).toBe('existing-id');
      expect(calls[0].args[2]).toBe(true); // activate flag
    });

    it('should call createSieveScript with activate when no activeScriptId', async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const mockClient = {
        updateSieveScript: async (...args: unknown[]) => { calls.push({ method: 'updateSieveScript', args }); },
        createSieveScript: async (...args: unknown[]) => {
          calls.push({ method: 'createSieveScript', args });
          return { id: 'new-id', name: 'filters', blobId: 'b1', isActive: true };
        },
      };
      useFilterStore.setState({
        activeScriptId: null,
        rules: [makeRule()],
        isOpaque: false,
      });
      await useFilterStore.getState().saveFilters(mockClient as unknown as IJMAPClient);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('createSieveScript');
      expect(calls[0].args[2]).toBe(true); // activate flag
      expect(useFilterStore.getState().activeScriptId).toBe('new-id');
    });

    it('should use rawScript when isOpaque', async () => {
      let savedContent = '';
      const mockClient = {
        updateSieveScript: async (_id: string, content: string) => { savedContent = content; },
      };
      useFilterStore.setState({
        activeScriptId: 'existing-id',
        rules: [],
        isOpaque: true,
        rawScript: 'require ["fileinto"];\nif header :contains "From" "x" { fileinto "Y"; }',
      });
      await useFilterStore.getState().saveFilters(mockClient as unknown as IJMAPClient);
      expect(savedContent).toContain('require ["fileinto"]');
    });

    it('should set error on failure', async () => {
      const mockClient = {
        updateSieveScript: async () => { throw new Error('Server error'); },
      };
      useFilterStore.setState({ activeScriptId: 'existing-id', rules: [makeRule()] });
      await expect(useFilterStore.getState().saveFilters(mockClient as unknown as IJMAPClient)).rejects.toThrow('Server error');
      expect(useFilterStore.getState().error).toBe('Server error');
      expect(useFilterStore.getState().isSaving).toBe(false);
    });

    it('should generate script content from rules when not opaque', async () => {
      let savedContent = '';
      const mockClient = {
        updateSieveScript: async (_id: string, content: string) => { savedContent = content; },
      };
      const rules = [makeRule({ name: 'My Filter' })];
      useFilterStore.setState({ activeScriptId: 'existing-id', rules, isOpaque: false });
      await useFilterStore.getState().saveFilters(mockClient as unknown as IJMAPClient);
      expect(savedContent).toContain('@metadata:begin');
      expect(savedContent).toContain('My Filter');
      expect(savedContent).toContain('fileinto "Archive"');
    });

    it('should update rawScript after successful save', async () => {
      const mockClient = {
        updateSieveScript: async () => {},
      };
      useFilterStore.setState({ activeScriptId: 'existing-id', rules: [makeRule()], isOpaque: false, rawScript: '' });
      await useFilterStore.getState().saveFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().rawScript).toContain('@metadata:begin');
    });
  });

  describe('setSupported', () => {
    it('should set isSupported flag', () => {
      useFilterStore.getState().setSupported(true);
      expect(useFilterStore.getState().isSupported).toBe(true);
      useFilterStore.getState().setSupported(false);
      expect(useFilterStore.getState().isSupported).toBe(false);
    });
  });

  describe('fetchFilters', () => {
    it('should prefer the active script over the first script', async () => {
      const { generateScript } = await import('@/lib/sieve/generator');
      const activeRules = [makeRule({ name: 'Active' })];
      const inactiveRules = [makeRule({ name: 'Inactive' })];

      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [
          { id: 's1', name: 'old', blobId: 'b1', isActive: false },
          { id: 's2', name: 'main', blobId: 'b2', isActive: true },
        ],
        getSieveScriptContent: async (blobId: string) => {
          if (blobId === 'b2') return generateScript(activeRules);
          return generateScript(inactiveRules);
        },
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().activeScriptId).toBe('s2');
      expect(useFilterStore.getState().rules[0].name).toBe('Active');
    });

    it('should set sieveCapabilities from client', async () => {
      const caps = { implementation: 'test', maxSizeScript: 10000, sieveExtensions: ['fileinto'], notificationMethods: [], externalLists: [] };
      const mockClient = {
        getSieveCapabilities: () => caps,
        getSieveScripts: async () => [],
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().sieveCapabilities).toEqual(caps);
    });

    it('should set rawScript from script content', async () => {
      const { generateScript } = await import('@/lib/sieve/generator');
      const rules = [makeRule()];
      const script = generateScript(rules);
      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [{ id: 's1', name: 'main', blobId: 'b1', isActive: true }],
        getSieveScriptContent: async () => script,
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().rawScript).toBe(script);
    });

    it('should skip the server-managed vacation script', async () => {
      const { generateScript } = await import('@/lib/sieve/generator');
      const rules = [makeRule({ name: 'MyFilter' })];
      const script = generateScript(rules);

      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [
          { id: 'vac-1', name: 'vacation', blobId: 'bv', isActive: true },
          { id: 's1', name: 'filters', blobId: 'b1', isActive: false },
        ],
        getSieveScriptContent: async (blobId: string) => {
          if (blobId === 'b1') return script;
          return 'require "vacation"; vacation "I am away";';
        },
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      // Should pick the 'filters' script, not the 'vacation' one
      expect(useFilterStore.getState().activeScriptId).toBe('s1');
      expect(useFilterStore.getState().rules[0].name).toBe('MyFilter');
    });

    it('should handle only vacation script present (no filter scripts)', async () => {
      const mockClient = {
        getSieveCapabilities: () => null,
        getSieveScripts: async () => [
          { id: 'vac-1', name: 'vacation', blobId: 'bv', isActive: true },
        ],
      };
      await useFilterStore.getState().fetchFilters(mockClient as unknown as IJMAPClient);
      expect(useFilterStore.getState().activeScriptId).toBeNull();
      expect(useFilterStore.getState().rules).toEqual([]);
    });
  });
});
