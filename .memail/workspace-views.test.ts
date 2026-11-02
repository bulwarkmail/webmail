import { beforeEach, describe, it, expect } from 'vitest';
import { useWorkspacePreferences } from './workspace-preferences';
import { acquireWorkspaceViews } from './workspace-views';
import { useMessageListTabsStore } from '../stores/message-list-tabs-store';

describe('native workspace views', () => {
  beforeEach(() => useWorkspacePreferences.setState({enabled:true, showNewsletters:true, focusMode:'Unread correspondence and starred'}));
  it('updates real query definitions and restores an unfiltered inbox when disabled', () => {
    const release = acquireWorkspaceViews();
    useWorkspacePreferences.getState().configure({focusMode:'Starred only', showNewsletters:false});
    const tabs = useMessageListTabsStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[1].query).toEqual({hasKeyword:'$flagged'});
    useWorkspacePreferences.getState().configure({enabled:false});
    expect(useMessageListTabsStore.getState().getCategoryFilter('inbox')).toBeNull();
    expect(useMessageListTabsStore.getState().tabs).toHaveLength(0);
    release();
  });
  it('shares a registration across panes and releases it after the last pane', () => {
    const first = acquireWorkspaceViews();
    const second = acquireWorkspaceViews();
    expect(useMessageListTabsStore.getState().tabs.map(t => t.id)).toEqual(['memail-all','memail-focus','memail-newsletters']);
    first(); first();
    expect(useMessageListTabsStore.getState().tabs).toHaveLength(3);
    second();
    expect(useMessageListTabsStore.getState().tabs).toHaveLength(0);
  });
  it('yields to explicit category providers and returns when they leave', () => {
    const release = acquireWorkspaceViews();
    const state = useMessageListTabsStore.getState();
    state.registerTabs('custom', {tabs:[{id:'primary',label:'Primary'}, {id:'tagged',label:'Tagged',keyword:'$custom'}]});
    expect(useMessageListTabsStore.getState().tabs.map(t => t.id)).toEqual(['primary','tagged']);
    state.clearTabs('custom');
    expect(useMessageListTabsStore.getState().tabs).toHaveLength(3);
    release();
  });
});
