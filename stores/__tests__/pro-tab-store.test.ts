import { beforeEach, describe, expect, it } from 'vitest';
import {
  useProTabStore,
  normalizeProTabState,
  type ProTab,
  type ProTabCoreState,
  type ProPaneId,
} from '@/stores/pro-tab-store';

const HOME_ID = 'home-mail';

function homeTab(): ProTab {
  return { id: HOME_ID, kind: 'mail', labelKey: 'mail', closeable: false, paneId: 'main' };
}

function emailTab(id: string, paneId: ProPaneId = 'main'): ProTab {
  return {
    id,
    kind: 'email',
    labelKey: '',
    title: id,
    closeable: true,
    paneId,
    emailData: { accountId: 'acc', emailId: `msg-${id}`, mailboxId: null, title: id },
  };
}

function appTab(id: string, kind: 'settings' | 'calendar' | 'contacts' | 'files', paneId: ProPaneId = 'main'): ProTab {
  return { id, kind, labelKey: kind, closeable: true, paneId };
}

function seed(state: Partial<ProTabCoreState> & { tabs: ProTab[] }) {
  useProTabStore.setState({
    activeTabId: state.tabs.find((t) => t.paneId === 'main')?.id ?? HOME_ID,
    activeSplitTabId: state.tabs.find((t) => t.paneId === 'split')?.id ?? null,
    focusedPaneId: 'main',
    splitOrientation: state.tabs.some((t) => t.paneId === 'split') ? 'vertical' : null,
    splitSide: 'right',
    readerTabId: null,
    loadedTabIds: state.tabs.map((t) => t.id),
    ...state,
  });
}

function reset() {
  seed({ tabs: [homeTab()] });
}

/** The invariants from the Pro shell contract (I1-I6). */
function assertInvariants(label = '') {
  const s = useProTabStore.getState();
  const main = s.tabs.filter((t) => t.paneId === 'main');
  const split = s.tabs.filter((t) => t.paneId === 'split');

  // I1: never empty.
  expect(s.tabs.length, `${label} I1`).toBeGreaterThan(0);
  // I4: main never empty.
  expect(main.length, `${label} I4`).toBeGreaterThan(0);
  // I3: active ids point into their panes.
  expect(main.some((t) => t.id === s.activeTabId), `${label} I3 main`).toBe(true);
  if (split.length === 0) {
    expect(s.activeSplitTabId, `${label} I2/I3 split`).toBeNull();
    expect(s.splitOrientation, `${label} I2 orientation`).toBeNull();
    // I5: focus can't sit on a nonexistent pane.
    expect(s.focusedPaneId, `${label} I5`).toBe('main');
  } else {
    expect(split.some((t) => t.id === s.activeSplitTabId), `${label} I3 split`).toBe(true);
    expect(s.splitOrientation, `${label} I2 orientation`).toBe('vertical');
  }
  // I6: loaded contains actives, and only existing tabs.
  expect(s.loadedTabIds, `${label} I6 active`).toContain(s.activeTabId);
  if (s.activeSplitTabId) {
    expect(s.loadedTabIds, `${label} I6 split active`).toContain(s.activeSplitTabId);
  }
  for (const id of s.loadedTabIds) {
    expect(s.tabs.some((t) => t.id === id), `${label} I6 ghost ${id}`).toBe(true);
  }
  // Reader tab must be a live email tab.
  if (s.readerTabId) {
    expect(
      s.tabs.some((t) => t.id === s.readerTabId && t.kind === 'email'),
      `${label} reader`,
    ).toBe(true);
  }
}

beforeEach(reset);

describe('openTab', () => {
  it('creates an app tab in the focused pane and activates it', () => {
    const id = useProTabStore.getState().openTab('settings');
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === id)?.kind).toBe('settings');
    expect(s.activeTabId).toBe(id);
    expect(s.focusedPaneId).toBe('main');
    assertInvariants();
  });

  it('is a singleton across panes: re-opening focuses the existing tab instead of duplicating', () => {
    seed({ tabs: [homeTab(), appTab('set', 'settings', 'split')], focusedPaneId: 'main' });
    const id = useProTabStore.getState().openTab('settings');
    const s = useProTabStore.getState();
    expect(id).toBe('set');
    expect(s.tabs.filter((t) => t.kind === 'settings')).toHaveLength(1);
    // Focus follows the tab to its pane.
    expect(s.focusedPaneId).toBe('split');
    expect(s.activeSplitTabId).toBe('set');
    assertInvariants();
  });

  it('focused in split with settings open in main: focuses main instead of opening a second settings tab', () => {
    seed({
      tabs: [homeTab(), appTab('set', 'settings', 'main'), emailTab('e1', 'split')],
      focusedPaneId: 'split',
    });
    const id = useProTabStore.getState().openTab('settings');
    const s = useProTabStore.getState();
    expect(id).toBe('set');
    expect(s.tabs.filter((t) => t.kind === 'settings')).toHaveLength(1);
    expect(s.activeTabId).toBe('set');
    expect(s.focusedPaneId).toBe('main');
    assertInvariants();
  });

  it('opens new tabs into the focused pane when a split exists', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split')], focusedPaneId: 'split' });
    const id = useProTabStore.getState().openTab('calendar');
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === id)?.paneId).toBe('split');
    expect(s.activeSplitTabId).toBe(id);
    assertInvariants();
  });
});

describe('openEmailTab', () => {
  const data = (n: number) => ({
    accountId: 'acc',
    emailId: `msg-${n}`,
    mailboxId: null,
    title: `Mail ${n}`,
  });

  it('opens in the focused pane by default', () => {
    const id = useProTabStore.getState().openEmailTab(data(1));
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === id)?.paneId).toBe('main');
    expect(s.activeTabId).toBe(id);
    assertInvariants();
  });

  it('focuses an already-open email instead of opening it twice', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split')], focusedPaneId: 'main' });
    const existing = useProTabStore.getState().tabs.find((t) => t.id === 'e1')!;
    const id = useProTabStore.getState().openEmailTab({
      accountId: existing.emailData!.accountId,
      emailId: existing.emailData!.emailId,
      mailboxId: null,
      title: 'whatever',
    });
    const s = useProTabStore.getState();
    expect(id).toBe('e1');
    expect(s.activeSplitTabId).toBe('e1');
    expect(s.focusedPaneId).toBe('split');
    assertInvariants();
  });

  it("pane: 'split' with no split creates one", () => {
    const id = useProTabStore.getState().openEmailTab(data(2), { pane: 'split' });
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === id)?.paneId).toBe('split');
    expect(s.splitOrientation).toBe('vertical');
    expect(s.activeSplitTabId).toBe(id);
    assertInvariants();
  });

  it('reuseReader drives a single tab across repeated opens in the same pane', () => {
    const first = useProTabStore.getState().openEmailTab(data(3), { pane: 'split', reuseReader: true });
    const second = useProTabStore.getState().openEmailTab(data(4), { pane: 'split', reuseReader: true });
    const s = useProTabStore.getState();
    expect(second).toBe(first);
    const reader = s.tabs.find((t) => t.id === first)!;
    expect(reader.emailData?.emailId).toBe('msg-4');
    expect(reader.title).toBe('Mail 4');
    expect(s.tabs.filter((t) => t.kind === 'email')).toHaveLength(1);
    assertInvariants();
  });

  it('creates a fresh reader when the old one moved to another pane', () => {
    const first = useProTabStore.getState().openEmailTab(data(5), { pane: 'split', reuseReader: true });
    useProTabStore.getState().moveTabToPane(first, 'main');
    const second = useProTabStore.getState().openEmailTab(data(6), { pane: 'split', reuseReader: true });
    const s = useProTabStore.getState();
    expect(second).not.toBe(first);
    expect(s.tabs.find((t) => t.id === first)?.emailData?.emailId).toBe('msg-5');
    expect(s.readerTabId).toBe(second);
    assertInvariants();
  });
});

describe('openFolderTab', () => {
  const data = (n: number, accountId: string | null = null) => ({
    accountId,
    mailboxId: `mb-${n}`,
    title: `Folder ${n}`,
  });

  it('opens in the focused pane by default and activates the tab', () => {
    const id = useProTabStore.getState().openFolderTab(data(1));
    const s = useProTabStore.getState();
    const tab = s.tabs.find((t) => t.id === id)!;
    expect(tab.kind).toBe('folder');
    expect(tab.folderData?.mailboxId).toBe('mb-1');
    expect(tab.paneId).toBe('main');
    expect(s.activeTabId).toBe(id);
    assertInvariants();
  });

  it('focuses an already-open folder instead of opening it twice', () => {
    const first = useProTabStore.getState().openFolderTab(data(2), { pane: 'split' });
    useProTabStore.getState().setFocusedPane('main');
    const second = useProTabStore.getState().openFolderTab(data(2));
    const s = useProTabStore.getState();
    expect(second).toBe(first);
    expect(s.tabs.filter((t) => t.kind === 'folder')).toHaveLength(1);
    expect(s.activeSplitTabId).toBe(first);
    expect(s.focusedPaneId).toBe('split');
    assertInvariants();
  });

  it('the same mailbox id under different accounts opens separate tabs', () => {
    const a = useProTabStore.getState().openFolderTab(data(3, null));
    const b = useProTabStore.getState().openFolderTab(data(3, 'acc-2'));
    expect(b).not.toBe(a);
    expect(useProTabStore.getState().tabs.filter((t) => t.kind === 'folder')).toHaveLength(2);
    assertInvariants();
  });

  it("pane: 'split' with no split creates one", () => {
    const id = useProTabStore.getState().openFolderTab(data(4), { pane: 'split' });
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === id)?.paneId).toBe('split');
    expect(s.splitOrientation).toBe('vertical');
    expect(s.activeSplitTabId).toBe(id);
    assertInvariants();
  });
});

describe('closeTab', () => {
  it('activates a neighbour when the active tab closes', () => {
    seed({ tabs: [homeTab(), appTab('a', 'calendar'), appTab('b', 'contacts')], activeTabId: 'a' });
    useProTabStore.getState().closeTab('a');
    const s = useProTabStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([HOME_ID, 'b']);
    expect(s.activeTabId).toBe('b');
    assertInvariants();
  });

  it('collapses the split when its last tab closes', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split')], focusedPaneId: 'split' });
    useProTabStore.getState().closeTab('e1');
    const s = useProTabStore.getState();
    expect(s.splitOrientation).toBeNull();
    expect(s.activeSplitTabId).toBeNull();
    expect(s.focusedPaneId).toBe('main');
    assertInvariants();
  });

  it('never closes the pinned home tab', () => {
    useProTabStore.getState().closeTab(HOME_ID);
    expect(useProTabStore.getState().tabs.some((t) => t.id === HOME_ID)).toBe(true);
    assertInvariants();
  });

  it('clears a stale readerTabId when the reader closes', () => {
    const id = useProTabStore.getState().openEmailTab(
      { accountId: 'acc', emailId: 'm', mailboxId: null, title: 'm' },
      { reuseReader: true },
    );
    expect(useProTabStore.getState().readerTabId).toBe(id);
    useProTabStore.getState().closeTab(id);
    expect(useProTabStore.getState().readerTabId).toBeNull();
    assertInvariants();
  });
});

describe('moveTabToPane', () => {
  it('creates a split on the requested side', () => {
    seed({ tabs: [homeTab(), appTab('cal', 'calendar')] });
    useProTabStore.getState().moveTabToPane('cal', 'split', { side: 'left' });
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === 'cal')?.paneId).toBe('split');
    expect(s.splitSide).toBe('left');
    expect(s.activeSplitTabId).toBe('cal');
    expect(s.focusedPaneId).toBe('split');
    assertInvariants();
  });

  it('keeps the persisted side when extending an existing split', () => {
    seed({ tabs: [homeTab(), appTab('cal', 'calendar'), emailTab('e1', 'split')], splitSide: 'left' });
    useProTabStore.getState().moveTabToPane('cal', 'split', { side: 'right' });
    expect(useProTabStore.getState().splitSide).toBe('left');
    assertInvariants();
  });

  it('merges panes instead of refusing when the last main tab moves into the split', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split'), emailTab('e2', 'split')] });
    useProTabStore.getState().moveTabToPane(HOME_ID, 'split');
    const s = useProTabStore.getState();
    // Everything ended up in one pane: no split remains.
    expect(s.tabs.every((t) => t.paneId === 'main')).toBe(true);
    expect(s.splitOrientation).toBeNull();
    // The moved tab is the active one - the user's drag intent is honoured.
    expect(s.activeTabId).toBe(HOME_ID);
    assertInvariants();
  });

  it('collapses the split when its last tab moves back to main', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split')] });
    useProTabStore.getState().moveTabToPane('e1', 'main');
    const s = useProTabStore.getState();
    expect(s.splitOrientation).toBeNull();
    expect(s.activeTabId).toBe('e1');
    assertInvariants();
  });
});

describe('reorderTab', () => {
  it('reorders within a pane', () => {
    seed({ tabs: [homeTab(), appTab('a', 'calendar'), appTab('b', 'contacts')] });
    useProTabStore.getState().reorderTab('b', HOME_ID, 'after');
    expect(useProTabStore.getState().tabs.map((t) => t.id)).toEqual([HOME_ID, 'b', 'a']);
    assertInvariants();
  });

  it('moves across panes and activates the moved tab there', () => {
    seed({ tabs: [homeTab(), appTab('a', 'calendar'), emailTab('e1', 'split')] });
    useProTabStore.getState().reorderTab('a', 'e1', 'after');
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === 'a')?.paneId).toBe('split');
    expect(s.activeSplitTabId).toBe('a');
    expect(s.focusedPaneId).toBe('split');
    assertInvariants();
  });

  it('merges panes when a cross-pane reorder empties main', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split')] });
    useProTabStore.getState().reorderTab(HOME_ID, 'e1', 'before');
    const s = useProTabStore.getState();
    expect(s.tabs.every((t) => t.paneId === 'main')).toBe(true);
    expect(s.splitOrientation).toBeNull();
    // Order carries the drop position.
    expect(s.tabs.map((t) => t.id)).toEqual([HOME_ID, 'e1']);
    assertInvariants();
  });
});

describe('focus and activation', () => {
  it('setFocusedPane(split) without a split is normalized back to main', () => {
    useProTabStore.getState().setFocusedPane('split');
    expect(useProTabStore.getState().focusedPaneId).toBe('main');
    assertInvariants();
  });

  it('setActiveTab activates in the correct pane and focuses it', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split')], focusedPaneId: 'main' });
    useProTabStore.getState().setActiveTab('e1');
    const s = useProTabStore.getState();
    expect(s.activeSplitTabId).toBe('e1');
    expect(s.focusedPaneId).toBe('split');
    // Main pane's active tab is untouched.
    expect(s.activeTabId).toBe(HOME_ID);
    assertInvariants();
  });

  it('collapseSplit returns every split tab to main', () => {
    seed({ tabs: [homeTab(), emailTab('e1', 'split'), emailTab('e2', 'split')] });
    useProTabStore.getState().collapseSplit();
    const s = useProTabStore.getState();
    expect(s.tabs.every((t) => t.paneId === 'main')).toBe(true);
    expect(s.splitOrientation).toBeNull();
    assertInvariants();
  });
});

describe('normalizeProTabState', () => {
  const base: ProTabCoreState = {
    tabs: [],
    activeTabId: 'nope',
    activeSplitTabId: 'nope',
    focusedPaneId: 'split',
    splitOrientation: 'vertical',
    splitSide: 'right',
    readerTabId: 'nope',
    loadedTabIds: ['ghost'],
  };

  it('restores the home tab when everything is gone', () => {
    const s = normalizeProTabState(base);
    expect(s.tabs.map((t) => t.id)).toEqual([HOME_ID]);
    expect(s.activeTabId).toBe(HOME_ID);
    expect(s.activeSplitTabId).toBeNull();
    expect(s.splitOrientation).toBeNull();
    expect(s.focusedPaneId).toBe('main');
    expect(s.loadedTabIds).toEqual([HOME_ID]);
  });

  it('promotes split tabs to main when main is empty (the "invisible tabs" healing)', () => {
    const s = normalizeProTabState({
      ...base,
      tabs: [emailTab('e1', 'split'), emailTab('e2', 'split')],
      activeSplitTabId: 'e2',
    });
    expect(s.tabs.every((t) => t.paneId === 'main')).toBe(true);
    expect(s.activeTabId).toBe('e2');
    expect(s.activeSplitTabId).toBeNull();
  });

  it('repairs invalid active ids, stale focus, ghost loaded ids and dead reader ids', () => {
    const s = normalizeProTabState({
      ...base,
      tabs: [homeTab(), emailTab('e1', 'split')],
      activeTabId: 'e1', // wrong pane
      activeSplitTabId: 'missing',
      loadedTabIds: ['ghost', HOME_ID],
      readerTabId: HOME_ID, // not an email tab
    });
    expect(s.activeTabId).toBe(HOME_ID);
    expect(s.activeSplitTabId).toBe('e1');
    expect(s.splitOrientation).toBe('vertical');
    expect(s.focusedPaneId).toBe('split');
    expect(s.loadedTabIds).toEqual([HOME_ID, 'e1']);
    expect(s.readerTabId).toBeNull();
  });

  it('backfills a missing paneId (v2 persisted tabs)', () => {
    const legacy = { ...homeTab() } as ProTab & { paneId?: ProPaneId };
    delete (legacy as { paneId?: ProPaneId }).paneId;
    const s = normalizeProTabState({ ...base, tabs: [legacy as ProTab], focusedPaneId: 'main' });
    expect(s.tabs[0].paneId).toBe('main');
  });
});

describe('property: random operation sequences never violate the invariants', () => {
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each([1, 7, 42, 1337])('seed %i', (seedValue) => {
    const rand = mulberry32(seedValue);
    reset();
    const kinds = ['mail', 'calendar', 'contacts', 'files', 'settings'] as const;
    for (let i = 0; i < 400; i++) {
      const s = useProTabStore.getState();
      const anyTab = s.tabs[Math.floor(rand() * s.tabs.length)];
      const otherTab = s.tabs[Math.floor(rand() * s.tabs.length)];
      const op = Math.floor(rand() * 9);
      switch (op) {
        case 0: s.openTab(kinds[Math.floor(rand() * kinds.length)]); break;
        case 1:
          s.openEmailTab(
            { accountId: 'acc', emailId: `m-${Math.floor(rand() * 25)}`, mailboxId: null, title: 'x' },
            rand() < 0.5
              ? { pane: rand() < 0.5 ? 'main' : 'split', reuseReader: rand() < 0.5 }
              : undefined,
          );
          break;
        case 2: s.openComposeTab({ sessionId: i, mode: 'compose', title: 'compose' }); break;
        case 3: if (anyTab) s.closeTab(anyTab.id); break;
        case 4:
          if (anyTab) {
            s.moveTabToPane(anyTab.id, rand() < 0.5 ? 'main' : 'split', {
              side: rand() < 0.5 ? 'left' : 'right',
            });
          }
          break;
        case 5:
          if (anyTab && otherTab) {
            s.reorderTab(anyTab.id, otherTab.id, rand() < 0.5 ? 'before' : 'after');
          }
          break;
        case 6: s.setFocusedPane(rand() < 0.5 ? 'main' : 'split'); break;
        case 7: if (anyTab) s.setActiveTab(anyTab.id); break;
        case 8: s.collapseSplit(); break;
      }
      assertInvariants(`seed ${seedValue} step ${i} op ${op}`);
    }
  });
});
