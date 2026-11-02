import { accountScope, buildFocusViews, type FocusSettings } from './views';

interface FocusApi {
  tabs: {getState(): Promise<{tabs:{id:string}[]}>; set(config: NonNullable<ReturnType<typeof buildFocusViews>>): Promise<void>; clear(): Promise<void>};
  ui: {setActions(surface: string, actions: {id:string;label:string;icon:string}[]): Promise<void>};
  user: {getSelf():Promise<{email:string}>};
  plugin: {settings: FocusSettings; onSettingsChange(listener: (settings: FocusSettings) => void): unknown};
  i18n: {t(key:string):string; onLocaleChange(listener: () => void):unknown};
  toast: {warning(message:string):void};
  log: {error(message:string, error:unknown):void};
}
const OWN_TAB_IDS = new Set(['memail-all','memail-focus','memail-newsletters']);
let api: FocusApi | null = null;
let settings: FocusSettings = {};
let hidden = false;
let pending = Promise.resolve();
let revision = 0;

function publish(): Promise<void> {
  const active = api;
  if (!active) return Promise.resolve();
  const request = ++revision;
  const snapshot = {...settings};
  const paused = hidden;
  // Serialize host writes, and discard stale asynchronous identity lookups.
  const task = pending.then(async () => {
    if (request !== revision) return;
    try {
      const scope = snapshot.enabled === false ? [] : accountScope(snapshot.accountNames);
      let eligible = true;
      if (snapshot.enabled !== false && scope.length) {
        // Clear before looking up a switched account, so old rules don't linger.
        await active.tabs.clear();
        const self = await active.user.getSelf();
        eligible = scope.includes(self.email.trim().toLowerCase());
      }
      if (request !== revision) return;
      const config = buildFocusViews({...snapshot,enabled:snapshot.enabled !== false && !paused && eligible}, key=>active.i18n.t(key));
      if (config) {
        const current = await active.tabs.getState();
        if (request !== revision) return;
        if (current.tabs.some(tab=>!OWN_TAB_IDS.has(tab.id))) throw new Error(active.i18n.t('error.otherTabs'));
        await active.tabs.set(config);
      } else await active.tabs.clear();
      if (request !== revision) return;
      await active.ui.setActions('command-palette', snapshot.enabled === false || !eligible ? [] : [{
        id:'toggle-focus-tabs',label:active.i18n.t(config ? 'action.hide' : 'action.show'),icon:'layout-columns',
      }]);
    } catch (error) {
      // Never leave stale filters active after a bad setting or identity error.
      if (request === revision) {
        await active.tabs.clear().catch(()=>{});
        await active.ui.setActions('command-palette',[]).catch(()=>{});
      }
      if (error instanceof Error && error.message.startsWith('error.')) throw new Error(active.i18n.t(error.message));
      throw error;
    }
  });
  pending = task.catch(() => {});
  return task;
}
function report(error:unknown):void {
  api?.log.error('Memail Focus Inbox could not update its views.',error);
  api?.toast.warning(error instanceof Error ? error.message : 'Memail Focus Inbox could not update its views.');
}
export async function activate(pluginApi: FocusApi): Promise<void> {
  api = pluginApi;
  settings = {...pluginApi.plugin.settings};
  hidden = false;
  await publish();
  pluginApi.plugin.onSettingsChange(next=>{settings={...next}; hidden=false; void publish().catch(report);});
  pluginApi.i18n.onLocaleChange(()=>{void publish().catch(report);});
}
export const hooks = {
  async onAccountSwitch():Promise<void> { await publish(); },
  async onTabsChange(tabs: {id:string}[]): Promise<void> {
    if (!api || hidden || !tabs.some(tab=>OWN_TAB_IDS.has(tab.id)) || !tabs.some(tab=>!OWN_TAB_IDS.has(tab.id))) return;
    // A universal All query would empty another plugin's complement bucket.
    hidden = true;
    api.toast.warning(api.i18n.t('error.otherTabs'));
    await publish();
  },
  async onAction({actionId}: {actionId:string}): Promise<void> {
    if (actionId !== 'toggle-focus-tabs' || settings.enabled === false) return;
    const previous = hidden;
    hidden = !hidden;
    try { await publish(); }
    catch(error) { hidden = previous; throw error; }
  },
};
