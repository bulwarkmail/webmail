import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountScope, buildFocusViews, type FocusSettings } from './plugins/focus-inbox/views';
import { activate, hooks } from './plugins/focus-inbox';
import { resolveTabFilter, useMessageListTabsStore, validateTabsConfig } from '../stores/message-list-tabs-store';
import { readPluginPackage } from '../lib/extension-package';

const manifest = JSON.parse(readFileSync(resolve('.memail/plugins/focus-inbox/manifest.json'),'utf8'));
const t = (key:string) => manifest.locales.en[key];
const config = () => buildFocusViews({},t)!;
function mockApi() {
  let settingChanged: (s:FocusSettings)=>void = ()=>{};
  let localeChanged = ()=>{};
  const api = {
    tabs:{getState:vi.fn().mockResolvedValue({tabs:[]}),set:vi.fn().mockResolvedValue(undefined),clear:vi.fn().mockResolvedValue(undefined)},
    ui:{setActions:vi.fn().mockResolvedValue(undefined)},
    user:{getSelf:vi.fn().mockResolvedValue({email:'alice@example.com'})},
    plugin:{settings:{} as FocusSettings,onSettingsChange:(cb:typeof settingChanged)=>{settingChanged=cb;}},
    i18n:{t,onLocaleChange:(cb:()=>void)=>{localeChanged=cb;}},
    toast:{warning:vi.fn()},
    log:{error:vi.fn()},
  };
  return {api,settings:(s:FocusSettings)=>settingChanged(s),locale:()=>localeChanged()};
}
afterEach(()=>{useMessageListTabsStore.getState().clearTabs(manifest.id);});
describe('native focus view compatibility',()=>{
  it('validates against the real host and keeps All as a positive filter',()=>{
    const valid=validateTabsConfig(config());
    expect(valid.tabs).toHaveLength(3);
    expect(resolveTabFilter(valid.tabs[0],valid.tabs)).toEqual({minSize:0});
    expect(valid.tabs.every(tab=>tab.query && !tab.keyword)).toBe(true);
  });
  it('switches native tabs without registration outside Inbox and clears its filter on unload',()=>{
    const store=useMessageListTabsStore.getState();
    store.registerTabs(manifest.id,config());
    expect(useMessageListTabsStore.getState().getCategoryFilter('sent')).toBeNull();
    expect(useMessageListTabsStore.getState().getCategoryFilter('inbox')).toEqual({minSize:0});
    store.setActiveTab('memail-focus','inbox-id');
    expect(useMessageListTabsStore.getState().getCategoryFilter('inbox')).toEqual(config().tabs[1].query);
    store.clearTabs(manifest.id);
    expect(useMessageListTabsStore.getState().getCategoryFilter('inbox')).toBeNull();
  });
  it('removing Newsletters does not remove the newsletter exclusion from Focus',()=>{
    const reduced=buildFocusViews({showNewsletters:false,showUnreadBadges:false},t)!;
    expect(validateTabsConfig(reduced).tabs).toHaveLength(2);
    expect(reduced.tabs.every(tab=>tab.showUnreadBadge===false)).toBe(true);
    expect(reduced.tabs[1].query).toEqual(config().tabs[1].query);
    expect(buildFocusViews({enabled:false},t)).toBeNull();
  });
});
// Interpret the RFC subset against independent mail fixtures to catch a
// mistaken AND/OR/NOT that would hide mail or drop starred newsletters.
function matches(filter:Record<string,unknown>, mail:{read:boolean;star:boolean;newsletter:boolean;size:number}):boolean {
  const children=filter.conditions as Record<string,unknown>[];
  if(filter.operator==='OR') return children.some(f=>matches(f,mail));
  if(filter.operator==='AND') return children.every(f=>matches(f,mail));
  if(filter.operator==='NOT') return !children.some(f=>matches(f,mail));
  if(filter.minSize!==undefined) return mail.size >= Number(filter.minSize);
  if(filter.header) return mail.newsletter;
  if(filter.hasKeyword==='$flagged') return mail.star;
  if(filter.notKeyword==='$seen') return !mail.read;
  throw new Error('Unexpected query condition');
}
describe('membership semantics',()=>{
  it.each([
    [true,false,false,false],[false,false,false,true],
    [true,true,false,true],[false,true,false,true],
    [true,false,true,false],[false,false,true,false],
    [true,true,true,true],[false,true,true,true],
  ])('read=%s starred=%s newsletter=%s -> Focus=%s',(read,star,newsletter,focus)=>{
    const mail={read,star,newsletter,size:0};
    const tabs=config().tabs;
    expect(matches(tabs[0].query!,mail)).toBe(true);
    expect(matches(tabs[1].query!,mail)).toBe(focus);
    expect(matches(tabs[2].query!,mail)).toBe(newsletter);
  });
});
describe('sandbox lifecycle',()=>{
  it('registers native views and toggles without mail access',async()=>{
    const {api}=mockApi(); await activate(api);
    expect(api.tabs.set).toHaveBeenLastCalledWith(config());
    await hooks.onAction({actionId:'toggle-focus-tabs'});
    expect(api.tabs.clear).toHaveBeenCalledTimes(1);
    expect(api.ui.setActions).toHaveBeenLastCalledWith('command-palette',[expect.objectContaining({label:t('action.show')})]);
    await hooks.onAction({actionId:'toggle-focus-tabs'});
    expect(api.tabs.set).toHaveBeenCalledTimes(2);
    expect(manifest.permissions).toEqual(['ui:message-list-tabs','ui:commands','account:read']);
  });
  it('updates settings and locale without reviving disabled views',async()=>{
    const control=mockApi(); await activate(control.api);
    control.settings({enabled:false});
    await hooks.onAction({actionId:'unrelated'});
    await vi.waitFor(()=>expect(control.api.ui.setActions).toHaveBeenLastCalledWith('command-palette',[]));
    control.locale();
    await vi.waitFor(()=>expect(control.api.tabs.clear).toHaveBeenCalledTimes(2));
    control.settings({enabled:true,showNewsletters:false});
    await vi.waitFor(()=>expect(control.api.tabs.set).toHaveBeenLastCalledWith(buildFocusViews({showNewsletters:false},t)));
  });

  it('refuses to alter an existing category plugin and yields if one loads later',async()=>{
    const first=mockApi(); first.api.tabs.getState.mockResolvedValue({tabs:[{id:'primary'}]});
    await expect(activate(first.api)).rejects.toThrow('Another inbox category plugin');
    expect(first.api.tabs.set).not.toHaveBeenCalled();
    const second=mockApi(); await activate(second.api);
    await hooks.onTabsChange([{id:'memail-all'},{id:'primary'}]);
    expect(second.api.tabs.clear).toHaveBeenCalledTimes(1);
    expect(second.api.toast.warning).toHaveBeenCalledOnce();
    expect(second.api.ui.setActions).toHaveBeenLastCalledWith('command-palette',[expect.objectContaining({label:t('action.show')})]);
  });
  it('lets activation failures reach the host instead of silently succeeding',async()=>{
    const {api}=mockApi(); api.tabs.set.mockRejectedValueOnce(new Error('host rejected'));
    await expect(activate(api)).rejects.toThrow('host rejected');
  });
});
it('installs the actual built ZIP through the upstream package validator',async()=>{
  execFileSync(process.execPath,['.memail/package-focus-plugin.mjs']);
  const result=await readPluginPackage(readFileSync(resolve('out/memail-focus-inbox.zip')),{appVersion:'1.19.1'});
  expect(result.manifest.id).toBe(manifest.id);
  expect(result.warnings).toEqual([]);
  expect(result.code).toContain('activate');
});

describe('configurable focus rules',()=>{
  it.each(['Unread correspondence and starred','All unread and starred','Starred only'] as const)('%s follows its documented membership',mode=>{
    const view=buildFocusViews({focusMode:mode},t)!;
    for(const read of [false,true]) for(const star of [false,true]) for(const newsletter of [false,true]) {
      const expected=star || (mode!=='Starred only' && !read && (mode==='All unread and starred' || !newsletter));
      expect(matches(view.tabs[1].query!,{read,star,newsletter,size:100})).toBe(expected);
      expect(matches(view.tabs[0].query!,{read,star,newsletter,size:100})).toBe(true);
    }
    expect(validateTabsConfig(view).tabs).toHaveLength(3);
  });
  it('normalizes literal account names and rejects unsupported input',()=>{
    expect(accountScope(' Alice@Example.com, work-alice ; ALICE@example.com ')).toEqual(['alice@example.com','work-alice']);
    expect(accountScope('')).toEqual([]);
    expect(accountScope(undefined)).toEqual([]);
    for(const invalid of [',,;','*@example.com','Alice <alice@example.com>','alice bob',123,'a'.repeat(255),Array.from({length:21},(_,i)=>`user${i}`).join(',')]) {
      expect(()=>accountScope(invalid)).toThrow('error.accountScope');
    }
    expect(()=>buildFocusViews({focusMode:'unknown' as never},t)).toThrow('error.focusMode');
  });
  it('applies only to the selected sign-in names and reevaluates account switches',async()=>{
    const control=mockApi(); control.api.plugin.settings={accountNames:'Alice@Example.com'};
    await activate(control.api);
    expect(control.api.tabs.set).toHaveBeenCalledOnce();
    control.api.user.getSelf.mockResolvedValue({email:'bob@example.com'});
    await hooks.onAccountSwitch();
    expect(control.api.tabs.set).toHaveBeenCalledOnce();
    expect(control.api.ui.setActions).toHaveBeenLastCalledWith('command-palette',[]);
    control.api.user.getSelf.mockResolvedValue({email:'ALICE@EXAMPLE.COM'});
    await hooks.onAccountSwitch();
    expect(control.api.tabs.set).toHaveBeenCalledTimes(2);
  });
  it('does not look up account identity when the scope is empty',async()=>{
    const {api}=mockApi(); await activate(api);
    expect(api.user.getSelf).not.toHaveBeenCalled();
  });
  it('drops an outdated identity lookup instead of registering the previous account rules',async()=>{
    const control=mockApi(); await activate(control.api);
    let finish:(value:{email:string})=>void = ()=>{};
    control.api.user.getSelf.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    control.settings({accountNames:'alice@example.com'});
    await vi.waitFor(()=>expect(control.api.user.getSelf).toHaveBeenCalledOnce());
    control.api.user.getSelf.mockResolvedValue({email:'bob@example.com'});
    const switched=hooks.onAccountSwitch();
    finish({email:'alice@example.com'});
    await switched;
    expect(control.api.tabs.set).toHaveBeenCalledTimes(1);
    expect(control.api.ui.setActions).toHaveBeenLastCalledWith('command-palette',[]);
  });
  it('clears old filters and presents a useful error on invalid settings, then recovers',async()=>{
    const control=mockApi(); await activate(control.api);
    control.settings({accountNames:'*@example.com'});
    await vi.waitFor(()=>expect(control.api.toast.warning).toHaveBeenCalledWith(t('error.accountScope')));
    expect(control.api.tabs.clear).toHaveBeenCalled();
    expect(control.api.ui.setActions).toHaveBeenLastCalledWith('command-palette',[]);
    control.settings({focusMode:'Starred only'});
    await vi.waitFor(()=>expect(control.api.tabs.set).toHaveBeenLastCalledWith(buildFocusViews({focusMode:'Starred only'},t)));
  });
  it('clears old views if the account lookup fails',async()=>{
    const control=mockApi(); control.api.plugin.settings={accountNames:'alice@example.com'};
    control.api.user.getSelf.mockRejectedValueOnce(new Error('Session unavailable'));
    await expect(activate(control.api)).rejects.toThrow('Session unavailable');
    expect(control.api.tabs.set).not.toHaveBeenCalled();
    expect(control.api.ui.setActions).toHaveBeenLastCalledWith('command-palette',[]);
  });
});
