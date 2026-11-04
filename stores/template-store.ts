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
import * as reducer from '@/lib/templates/template-reducer';
import { registerTemplateSyncBridge } from './settings-store';
import { notifyPersonalChange, useAccountTemplatesStore } from './account-templates-store';
import { withStorableId } from '@/lib/templates/metadata-templates';
import { templateHooks } from '@/lib/plugin-hooks';
import { templateToView } from '@/lib/plugin-projection';
import { htmlToPlainText } from '@/lib/html-to-text';
import { escapeHtml } from '@/lib/email-sanitization';

const MAX_RECENT = 5;

const listOf = (state: { templates: EmailTemplate[]; deletedTemplateIds: Record<string, string> }): reducer.TemplateListState =>
  ({ templates: state.templates, deletedTemplateIds: state.deletedTemplateIds });

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
        const { state, template } = reducer.addTemplate(listOf(get()), data);
        set(state);
        void templateHooks.onTemplateCreate.emit(templateToView(template));
        return template;
      },

      updateTemplate: (id, updates) => {
        set(reducer.updateTemplate(listOf(get()), id, updates));
        emitTemplateUpdate(id);
      },

      deleteTemplate: (id) => {
        if (!get().templates.some((t) => t.id === id)) return;
        set((state) => ({
          ...reducer.deleteTemplate(listOf(state), id),
          recentTemplateIds: state.recentTemplateIds.filter((rid) => rid !== id),
        }));
        void templateHooks.onTemplateDelete.emit({ templateId: id });
      },

      duplicateTemplate: (id, nameSuffix) => {
        const result = reducer.duplicateTemplate(listOf(get()), id, nameSuffix);
        if (!result) return null;
        set(result.state);
        void templateHooks.onTemplateCreate.emit(templateToView(result.template));
        return result.template;
      },

      toggleFavorite: (id) => {
        set(reducer.toggleFavorite(listOf(get()), id));
        emitTemplateUpdate(id);
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
          set(reducer.appendTemplates(listOf(get()), result.templates));
          void templateHooks.onTemplatesImport.emit({ count: result.templates.length });
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

function emitTemplateUpdate(id: string): void {
  const template = useTemplateStore.getState().templates.find((t) => t.id === id);
  if (template) void templateHooks.onTemplateUpdate.emit(templateToView(template));
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

/**
 * Hands a template about to be inserted into the composer to the
 * onTemplateRender plugins. Returns null when no plugin listens, so the
 * composer keeps its own rendering; otherwise the plugins' version, with any
 * field a plugin returned as a non-string kept from the input. When a plugin
 * changed only the HTML or only the text, the other is made from it: the
 * composer uses one or the other depending on its mode, and the old one
 * would leave the plugin's change out of a plain-text (or rich) draft.
 */
export async function renderTemplateWithPlugins(
  templateId: string,
  rendered: RenderedTemplate,
): Promise<RenderedTemplate | null> {
  if (templateHooks.onTemplateRender.size === 0) return null;
  const result = await templateHooks.onTemplateRender.transform(rendered, { templateId }) as Partial<RenderedTemplate> | null;
  let html = typeof result?.html === 'string' ? result.html : rendered.html;
  let text = typeof result?.text === 'string' ? result.text : rendered.text;
  if (html !== rendered.html && text === rendered.text) {
    text = htmlToPlainText(html, { paragraphSpacing: true, mailMarkup: true });
  } else if (text !== rendered.text && html === rendered.html) {
    html = `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`;
  }
  return {
    subject: typeof result?.subject === 'string' ? result.subject : rendered.subject,
    html,
    text,
  };
}

/** Tells plugins a template was inserted into the composer. */
export function notifyTemplateApplied(template: EmailTemplate): void {
  void templateHooks.onTemplateApply.emit(templateToView(template));
}

// Every tab keeps its own in-memory copy and writes the whole list back to
// localStorage on any change, so a second tab that never saw a template
// created in the first one would overwrite it (and push the shorter list).
// Pick up the other tab's write instead.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'template-storage' || event.storageArea !== window.localStorage) return;
    void useTemplateStore.persist.rehydrate();
  });
}

// Registers templates with the cross-device settings sync (#825): they are
// included in the synced blob / settings export, applied back on server loads
// and file imports, and template changes schedule a sync push. Registration
// (rather than settings-store importing this module) avoids an import cycle -
// see registerTemplateSyncBridge.
//
// An account that keeps its templates in its own Inbox metadata (Stalwart
// 1.0, account-templates-store) leaves the blob once its marker entry is on
// the server: from then on its pushes carry no templates, and the flag has
// the stored blob drop its copy. Until then the blob syncs the browser's
// list as before. A blob loaded for such an account is merged into the
// browser's list as always and into the account's copy as well, so
// templates that only the blob has still reach the account.
const accountCopy = (accountId: string | undefined) => {
  const accounts = useAccountTemplatesStore.getState();
  const id = accountId ?? accounts.active ?? undefined;
  return id ? accounts.personal[id] : undefined;
};

function mergeIntoAccount(accountId: string, templates: unknown, deletedTemplateIds: unknown): void {
  const incoming = parseSyncedTemplates(templates);
  if (!incoming || incoming.length === 0) return;
  useAccountTemplatesStore.getState().updatePersonal(accountId, (copy) => ({
    ...copy,
    ...mergeSyncedTemplates(
      { templates: copy.templates, deletedTemplateIds: copy.deletedTemplateIds },
      { templates: incoming.map(withStorableId), deletedTemplateIds: parseTemplateTombstones(deletedTemplateIds) },
    ),
  }));
  notifyPersonalChange(accountId);
}

registerTemplateSyncBridge(
  {
    getSyncedState: (opts) => {
      const copy = accountCopy(opts?.accountId);
      if (copy?.markerOnServer) return { templates: copy.templates, deletedTemplateIds: copy.deletedTemplateIds, storedInAccount: true };
      const { templates, deletedTemplateIds } = useTemplateStore.getState();
      return { templates, deletedTemplateIds };
    },
    applySyncedState: (templates, deletedTemplateIds, opts) => {
      if (opts.accountId) {
        useTemplateStore.getState().applySyncedState(templates, deletedTemplateIds, opts);
        if (accountCopy(opts.accountId)) mergeIntoAccount(opts.accountId, templates, deletedTemplateIds);
        return;
      }
      // A settings file the user imports: into the active account's copy
      // when it keeps one, added by id (never a wholesale replace, which
      // would delete server templates).
      const active = useAccountTemplatesStore.getState().active;
      if (active && accountCopy(active)) {
        mergeIntoAccount(active, templates, {});
        return;
      }
      useTemplateStore.getState().applySyncedState(templates, deletedTemplateIds, opts);
    },
  },
  (listener) => {
    useTemplateStore.subscribe(listener);
    // An account whose marker just reached the server pushes once, so the
    // blob drops its copy.
    useAccountTemplatesStore.subscribe((state, prev) => {
      const newlyMarked = Object.entries(state.personal).some(([id, copy]) => copy.markerOnServer && !prev.personal[id]?.markerOnServer);
      if (newlyMarked) listener();
    });
  }
);
