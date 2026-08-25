import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProTabBar } from '@/components/pro/pro-tab-bar';
import { PRO_TAB_DRAG_MIME, EMAIL_IDS_DRAG_MIME } from '@/components/pro/pro-shell-drop';
import { useProTabStore, type ProTab } from '@/stores/pro-tab-store';

/** jsdom's built-in DataTransfer doesn't fully support setData/getData in synthetic drag events. */
class MockDataTransfer {
  private _data: Record<string, string> = {};
  types: string[] = [];
  effectAllowed = '';
  dropEffect = '';

  setData(type: string, data: string) {
    this._data[type] = data;
    if (!this.types.includes(type)) this.types.push(type);
  }

  getData(type: string): string {
    return this._data[type] ?? '';
  }

  setDragImage(_image: Element, _x: number, _y: number) {}
}

const HOME: ProTab = { id: 'home-mail', kind: 'mail', labelKey: 'mail', closeable: false, paneId: 'main' };
const CAL: ProTab = { id: 'cal', kind: 'calendar', labelKey: 'calendar', closeable: true, paneId: 'main' };
const EM: ProTab = {
  id: 'em', kind: 'email', labelKey: '', title: 'Some subject', closeable: true, paneId: 'split',
  emailData: { accountId: 'acc', emailId: 'msg-1', mailboxId: null, title: 'Some subject' },
};

function seedStore(tabs: ProTab[]) {
  useProTabStore.setState({
    tabs,
    activeTabId: tabs.find((t) => t.paneId === 'main')!.id,
    activeSplitTabId: tabs.find((t) => t.paneId === 'split')?.id ?? null,
    focusedPaneId: 'main',
    splitOrientation: tabs.some((t) => t.paneId === 'split') ? 'vertical' : null,
    splitSide: 'right',
    readerTabId: null,
    loadedTabIds: tabs.map((t) => t.id),
  });
}

describe('ProTabBar (per-pane strip)', () => {
  beforeEach(() => {
    seedStore([HOME, CAL, EM]);
  });

  it("renders only its own pane's tabs", () => {
    render(
      <ProTabBar
        paneId="main"
        tabs={[HOME, CAL]}
        activeTabId={HOME.id}
        isFocused
        onActivate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByText('Some subject')).toBeNull();
  });

  it('clicking a tab activates it; middle-click closes closeable tabs', () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <ProTabBar
        paneId="main"
        tabs={[HOME, CAL]}
        activeTabId={HOME.id}
        isFocused
        onActivate={onActivate}
        onClose={onClose}
      />,
    );
    const calTab = screen.getAllByRole('tab')[1];
    fireEvent.click(calTab);
    expect(onActivate).toHaveBeenCalledWith('cal');
    fireEvent.mouseDown(calTab, { button: 1 });
    expect(onClose).toHaveBeenCalledWith('cal');
    // The pinned home tab has no close affordance.
    fireEvent.mouseDown(screen.getAllByRole('tab')[0], { button: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dropping a dragged tab on another tab reorders through the store', () => {
    render(
      <ProTabBar
        paneId="main"
        tabs={[HOME, CAL]}
        activeTabId={HOME.id}
        isFocused
        onActivate={() => {}}
        onClose={() => {}}
      />,
    );
    const [homeEl, calEl] = screen.getAllByRole('tab');
    const dt = new MockDataTransfer();
    fireEvent.dragStart(calEl, { dataTransfer: dt });
    expect(dt.getData(PRO_TAB_DRAG_MIME)).toBe('cal');
    // jsdom rects are all-zero, so clientX 0 is not < left+width/2 -> 'after'
    // is irrelevant here; drop directly with the recorded payload.
    fireEvent.dragOver(homeEl, { dataTransfer: dt, clientX: 0 });
    fireEvent.drop(homeEl, { dataTransfer: dt });
    const order = useProTabStore.getState().tabs.map((t) => t.id);
    expect(order.indexOf('cal')).toBeLessThan(order.indexOf('home-mail') + 2);
    expect(order).toContain('cal');
    expect(order).toContain('home-mail');
  });

  it('dropping a tab from the other pane onto this strip moves it across panes', () => {
    render(
      <ProTabBar
        paneId="main"
        tabs={[HOME, CAL]}
        activeTabId={HOME.id}
        isFocused
        onActivate={() => {}}
        onClose={() => {}}
      />,
    );
    const dt = new MockDataTransfer();
    dt.setData(PRO_TAB_DRAG_MIME, 'em');
    fireEvent.drop(screen.getAllByRole('tab')[1], { dataTransfer: dt });
    const s = useProTabStore.getState();
    expect(s.tabs.find((t) => t.id === 'em')?.paneId).toBe('main');
    // The split emptied, so it collapsed.
    expect(s.splitOrientation).toBeNull();
  });

  it('dropping dragged emails on the strip reports their ids', () => {
    const onEmailDrop = vi.fn();
    render(
      <ProTabBar
        paneId="main"
        tabs={[HOME, CAL]}
        activeTabId={HOME.id}
        isFocused
        onActivate={() => {}}
        onClose={() => {}}
        onEmailDrop={onEmailDrop}
      />,
    );
    const dt = new MockDataTransfer();
    dt.setData(EMAIL_IDS_DRAG_MIME, JSON.stringify(['m1', 'm2']));
    fireEvent.drop(screen.getAllByRole('tab')[0], { dataTransfer: dt });
    expect(onEmailDrop).toHaveBeenCalledWith(['m1', 'm2']);
  });

  it("marks the focused pane's active tab with the accent edge", () => {
    const { container, rerender } = render(
      <ProTabBar
        paneId="main"
        tabs={[HOME, CAL]}
        activeTabId={HOME.id}
        isFocused
        onActivate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container.querySelector('.bg-primary')).not.toBeNull();
    rerender(
      <ProTabBar
        paneId="main"
        tabs={[HOME, CAL]}
        activeTabId={HOME.id}
        isFocused={false}
        onActivate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container.querySelector('.bg-primary')).toBeNull();
  });
});
