import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FOCUS_MODES, type FocusMode } from './plugins/focus-inbox/views';
interface WorkspacePreferences {
  focusMode: FocusMode;
  enabled: boolean;
  showNewsletters: boolean;
  configure: (patch: Partial<Pick<WorkspacePreferences, 'focusMode' | 'enabled' | 'showNewsletters'>>) => void;
}
export const useWorkspacePreferences = create<WorkspacePreferences>()(persist((set) => ({
  focusMode: FOCUS_MODES[0], enabled: true, showNewsletters: true,
  configure: patch => set(patch),
}), {
  name: 'memail-workspace-preferences', version: 1,
  partialize: ({focusMode, enabled, showNewsletters}) => ({focusMode, enabled, showNewsletters}),
  merge: (saved, current) => {
    const value = (saved ?? {}) as Partial<WorkspacePreferences>;
    return {...current,
      focusMode: FOCUS_MODES.includes(value.focusMode as FocusMode) ? value.focusMode! : current.focusMode,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : current.enabled,
      showNewsletters: typeof value.showNewsletters === 'boolean' ? value.showNewsletters : current.showNewsletters,
    };
  },
}));
