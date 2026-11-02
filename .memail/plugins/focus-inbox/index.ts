import { buildFocusViews, type FocusSettings } from './views';

interface FocusApi {
  tabs: {getState(): Promise<{tabs:{id:string}[]}>; set(config: NonNullable<ReturnType<typeof buildFocusViews>>): Promise<void>; clear(): Promise<void>};
  ui: {setActions(surface: string, actions: {id:string;label:string;icon:string}[]): Promise<void>};
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

function publish(): Promise<void> {
  const active = api;
  if (!active) return Promise.resolve();
  // Serialize updates so locale/settings changes cannot leave an older
  // registration visible after a newer one.
  const task = pending.then(async () => {
    const config = buildFocusViews({...settings,enabled:settings.enabled !== false && !hidden}, key=>active.i18n.t(key));
    if (config) {
      const current = await active.tabs.getState();
      if (current.tabs.some(tab=>!OWN_TAB_IDS.has(tab.id))) {
        throw new Error(active.i18n.t('error.otherTabs'));
      }
      await active.tabs.set(config);
    }
    else await active.tabs.clear();
    await active.ui.setActions('command-palette', settings.enabled === false ? [] : [{
      id:'toggle-focus-tabs',label:active.i18n.t(config ? 'action.hide' : 'action.show'),icon:'layout-columns',
    }]);
  });
  pending = task.catch(() => {});
  return task;
}
export async function activate(pluginApi: FocusApi): Promise<void> {
  api = pluginApi;
  settings = {...pluginApi.plugin.settings};
  hidden = false;
  await publish();
  pluginApi.plugin.onSettingsChange(next=>{settings={...next}; hidden=false; void publish().catch(error=>pluginApi.log.error('Memail Focus Inbox could not update its views.', error));});
  pluginApi.i18n.onLocaleChange(()=>{void publish().catch(error=>pluginApi.log.error('Memail Focus Inbox could not update its views.', error));});
}
export const hooks = {
  async onTabsChange(tabs: {id:string}[]): Promise<void> {
    if (!api || hidden || !tabs.some(tab=>OWN_TAB_IDS.has(tab.id)) || !tabs.some(tab=>!OWN_TAB_IDS.has(tab.id))) return;
    // A universal All query would empty another plugin's complement bucket.
    // Yield to that plugin rather than silently changing its membership.
    hidden = true;
    api.toast.warning(api.i18n.t('error.otherTabs'));
    await publish();
  },
  async onAction({actionId}: {actionId:string}): Promise<void> {
    if (actionId !== 'toggle-focus-tabs' || settings.enabled === false) return;
    hidden = !hidden;
    await publish();
  },
};
