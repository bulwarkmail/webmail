import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EmailTemplate } from '@/lib/template-types';
import {
  exportTemplates as exportUtil,
  importTemplates as importUtil,
  filterTemplates,
  mergeSyncedTemplates,
  parseSyncedTemplates,
  parseTemplateTombstones,
} from '@/lib/template-utils';
import { generateUUID } from '@/lib/utils';
import { registerTemplateSyncBridge } from './settings-store';

const MAX_RECENT = 5;

interface TemplateStore {
  templates: EmailTemplate[];
  recentTemplateIds: string[];
  /**
   * Template id -> ISO time it was deleted. Synced alongside `templates` in
   * the settings blob so deletions propagate across devices instead of being
   * resurrected by the next merge (see applySyncedState).
   */
  deletedTemplateIds: Record<string, string>;

  addTemplate: (template: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>) => EmailTemplate;
  updateTemplate: (id: string, updates: Partial<Omit<EmailTemplate, 'id' | 'createdAt'>>) => void;
  deleteTemplate: (id: string) => void;
  duplicateTemplate: (id: string, nameSuffix?: string) => EmailTemplate | null;
  toggleFavorite: (id: string) => void;
  recordUsage: (id: string) => void;

  getTemplatesByCategory: () => Record<string, EmailTemplate[]>;
  getFavorites: () => EmailTemplate[];
  getRecent: () => EmailTemplate[];
  searchTemplates: (query: string) => EmailTemplate[];

  exportAllTemplates: () => string;
  importTemplates: (json: string) => { count: number; errors: string[] };

  /**
   * Applies a `templates` / `deletedTemplateIds` pair from a synced settings
   * blob or settings-file import. `merge: true` (per-account server loads)
   * merges by id with the newer `updatedAt` winning; `merge: false` (file
   * imports) replaces wholesale. A blob from a build that predates template
   * sync (no `templates` array) leaves the local store untouched.
   */
  applySyncedState: (
    templates: unknown,
    deletedTemplateIds: unknown,
    opts: { merge: boolean }
  ) => void;
}

export const useTemplateStore = create<TemplateStore>()(
  persist(
    (set, get) => ({
      templates: [],
      recentTemplateIds: [],
      deletedTemplateIds: {},

      addTemplate: (data) => {
        const now = new Date().toISOString();
        const template: EmailTemplate = {
          ...data,
          id: generateUUID(),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          templates: [...state.templates, template],
        }));
        return template;
      },

      updateTemplate: (id, updates) => {
        set((state) => ({
          templates: state.templates.map((t) =>
            t.id === id
              ? { ...t, ...updates, updatedAt: new Date().toISOString() }
              : t
          ),
        }));
      },

      deleteTemplate: (id) => {
        set((state) => ({
          templates: state.templates.filter((t) => t.id !== id),
          recentTemplateIds: state.recentTemplateIds.filter((rid) => rid !== id),
          deletedTemplateIds: {
            ...state.deletedTemplateIds,
            [id]: new Date().toISOString(),
          },
        }));
      },

      duplicateTemplate: (id, nameSuffix) => {
        const original = get().templates.find((t) => t.id === id);
        if (!original) return null;

        const now = new Date().toISOString();
        const duplicate: EmailTemplate = {
          ...original,
          id: generateUUID(),
          name: `${original.name} ${nameSuffix || '(copy)'}`,

          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        };

        set((state) => ({
          templates: [...state.templates, duplicate],
        }));
        return duplicate;
      },

      toggleFavorite: (id) => {
        set((state) => ({
          templates: state.templates.map((t) =>
            t.id === id ? { ...t, isFavorite: !t.isFavorite, updatedAt: new Date().toISOString() } : t
          ),
        }));
      },

      recordUsage: (id) => {
        set((state) => {
          const filtered = state.recentTemplateIds.filter((rid) => rid !== id);
          return {
            recentTemplateIds: [id, ...filtered].slice(0, MAX_RECENT),
          };
        });
      },

      getTemplatesByCategory: () => {
        const { templates } = get();
        const grouped: Record<string, EmailTemplate[]> = {};
        for (const t of templates) {
          const cat = t.category || '';
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(t);
        }
        return grouped;
      },

      getFavorites: () => {
        return get().templates.filter((t) => t.isFavorite);
      },

      getRecent: () => {
        const { templates, recentTemplateIds } = get();
        return recentTemplateIds
          .map((id) => templates.find((t) => t.id === id))
          .filter(Boolean) as EmailTemplate[];
      },

      searchTemplates: (query) => {
        return filterTemplates(get().templates, query);
      },

      exportAllTemplates: () => {
        return exportUtil(get().templates);
      },

      importTemplates: (json) => {
        const result = importUtil(json);
        if (result.templates.length > 0) {
          set((state) => ({
            templates: [...state.templates, ...result.templates],
          }));
        }
        return { count: result.templates.length, errors: result.errors };
      },

      applySyncedState: (templatesValue, tombstonesValue, opts) => {
        const incoming = parseSyncedTemplates(templatesValue);
        if (!incoming) return;
        const incomingTombstones = parseTemplateTombstones(tombstonesValue);

        set((state) => {
          const next = opts.merge
            ? mergeSyncedTemplates(
                { templates: state.templates, deletedTemplateIds: state.deletedTemplateIds },
                { templates: incoming, deletedTemplateIds: incomingTombstones }
              )
            : { templates: incoming, deletedTemplateIds: incomingTombstones };
          const ids = new Set(next.templates.map((t) => t.id));
          return {
            ...next,
            recentTemplateIds: state.recentTemplateIds.filter((id) => ids.has(id)),
          };
        });
      },
    }),
    {
      name: 'template-storage',
      version: 1,
    }
  )
);

// Registers templates with the cross-device settings sync (#825): they are
// included in the synced blob / settings export, applied back on server loads
// and file imports, and template changes schedule a sync push. Registration
// (rather than settings-store importing this module) avoids an import cycle -
// see registerTemplateSyncBridge.
registerTemplateSyncBridge(
  {
    getSyncedState: () => {
      const { templates, deletedTemplateIds } = useTemplateStore.getState();
      return { templates, deletedTemplateIds };
    },
    applySyncedState: (templates, deletedTemplateIds, opts) =>
      useTemplateStore.getState().applySyncedState(templates, deletedTemplateIds, opts),
  },
  (listener) => useTemplateStore.subscribe(listener)
);
