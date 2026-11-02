import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FOCUS_MODES, type FocusMode } from './plugins/focus-inbox/views';
interface WorkspacePreferences {
  focusMode: FocusMode;
  enabled: boolean;
  showNewsletters: boolean;
  showSenderAvatars: boolean;
  configure: (patch: Partial<Pick<WorkspacePreferences, 'focusMode' | 'enabled' | 'showNewsletters' | 'showSenderAvatars'>>) => void;
}
export const useWorkspacePreferences = create<WorkspacePreferences>()(persist((set) => ({
  focusMode: FOCUS_MODES[0], enabled: true, showNewsletters: true, showSenderAvatars: true,
  configure: patch => set(patch),
}), {
  name: 'memail-workspace-preferences', version: 1,
  partialize: ({focusMode, enabled, showNewsletters, showSenderAvatars}) => ({focusMode, enabled, showNewsletters, showSenderAvatars}),
  merge: (saved, current) => {
    const value = (saved ?? {}) as Partial<WorkspacePreferences>;
    return {...current,
      showSenderAvatars: typeof value.showSenderAvatars === 'boolean' ? value.showSenderAvatars : current.showSenderAvatars,
      focusMode: FOCUS_MODES.includes(value.focusMode as FocusMode) ? value.focusMode! : current.focusMode,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : current.enabled,
      showNewsletters: typeof value.showNewsletters === 'boolean' ? value.showNewsletters : current.showNewsletters,
    };
  },
}));
