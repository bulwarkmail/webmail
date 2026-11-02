import { useMessageListTabsStore, validateTabsConfig } from '../stores/message-list-tabs-store';
import { useWorkspacePreferences } from './workspace-preferences';
import { buildFocusViews } from './plugins/focus-inbox/views';

const owner = 'memail-workspace';
const labels: Record<string, string> = {
  'tab.starred': 'Starred', 'tab.unread': 'Unread + starred', 'tab.all': 'All inbox', 'tab.focus': 'Focus', 'tab.newsletters': 'Newsletters',
};
let consumers = 0;
let unsubscribe: (() => void) | undefined;

/** Native workspace defaults yield to explicitly installed category providers.
 * Multiple mounted mail panes share one registration and one subscription. */
export function acquireWorkspaceViews(): () => void {
  if (consumers++ === 0) {
    const reconcile = () => {
      const state = useMessageListTabsStore.getState();
      const foreign = Object.keys(state.registrations).some(id => id !== owner);
      const config = buildFocusViews(useWorkspacePreferences.getState(), key => labels[key] ?? key);
      if (foreign || !config) {
        if (state.registrations[owner]) state.clearTabs(owner);
      } else if (JSON.stringify(state.registrations[owner]) !== JSON.stringify(config)) {
        // The host normalizes configs, so compare against its validated form.
        const normalized = validateTabsConfig(config);
        if (JSON.stringify(state.registrations[owner]) !== JSON.stringify(normalized)) state.registerTabs(owner, config);
      }
    };
    const stopTabs = useMessageListTabsStore.subscribe((state, previous) => {
      if (state.registrations !== previous.registrations) reconcile();
    });
    const stopPreferences = useWorkspacePreferences.subscribe(reconcile);
    unsubscribe = () => { stopTabs(); stopPreferences(); };
    reconcile();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--consumers === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
      useMessageListTabsStore.getState().clearTabs(owner);
    }
  };
}
