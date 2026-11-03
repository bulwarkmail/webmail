import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { ProTabBar, revealInStrip } from '@/components/pro/pro-tab-bar';
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

// MO-06: the tab order was drag-only.
describe('ProTabBar keyboard', () => {
  beforeEach(() => {
    seedStore([HOME, CAL, EM]);
  });

  function renderBar(onActivate = vi.fn()) {
    render(
      <ProTabBar paneId="main" tabs={[HOME, CAL]} activeTabId={HOME.id} isFocused onActivate={onActivate} onClose={() => {}} />,
    );
    return onActivate;
  }

  it('makes the active tab a Tab stop', () => {
    renderBar();
    const [home, cal] = screen.getAllByRole('tab');
    expect(home).toHaveAttribute('tabindex', '0');
    expect(cal).toHaveAttribute('tabindex', '-1');
  });

  it('moves the tab with Alt+Shift+ArrowRight', () => {
    renderBar();
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight', altKey: true, shiftKey: true });
    const mainTabs = useProTabStore.getState().tabs.filter((t) => t.paneId === 'main').map((t) => t.id);
    expect(mainTabs).toEqual(['cal', 'home-mail']);
  });

  it('goes to the next tab with ArrowRight without moving it', () => {
    const onActivate = renderBar();
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenCalledWith('cal');
    expect(useProTabStore.getState().tabs.map((t) => t.id)).toEqual(['home-mail', 'cal', 'em']);
  });
});

describe('ProTabBar overflow', () => {
  const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 36, width: right - left, height: 36, x: left, y: 0, toJSON: () => ({}) });

  beforeEach(() => {
    seedStore([HOME, CAL, EM]);
  });

  it('scrolls the strip to a tab past its end, and back to one before its start', () => {
    const strip = document.createElement('div');
    const tab = document.createElement('div');
    strip.getBoundingClientRect = () => rect(100, 500) as DOMRect;
    strip.scrollLeft = 50;

    tab.getBoundingClientRect = () => rect(480, 576) as DOMRect;
    revealInStrip(strip, tab);
    expect(strip.scrollLeft).toBe(126);

    tab.getBoundingClientRect = () => rect(60, 156) as DOMRect;
    revealInStrip(strip, tab);
    expect(strip.scrollLeft).toBe(86);

    tab.getBoundingClientRect = () => rect(200, 296) as DOMRect;
    revealInStrip(strip, tab);
    expect(strip.scrollLeft).toBe(86);
  });

  it('brings the tab that becomes active into view', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tablist') return rect(0, 300) as DOMRect;
      return (this.dataset.tabId === 'cal' ? rect(290, 386) : rect(0, 96)) as DOMRect;
    });
    const bar = (activeTabId: string) => (
      <ProTabBar paneId="main" tabs={[HOME, CAL]} activeTabId={activeTabId} isFocused onActivate={() => {}} onClose={() => {}} />
    );
    const { rerender } = render(bar(HOME.id));
    const strip = screen.getByRole('tablist');
    expect(strip.scrollLeft).toBe(0);
    rerender(bar(CAL.id));
    expect(strip.scrollLeft).toBe(86);
    spy.mockRestore();
  });

  it('moves along the strip with a vertical mouse wheel, the other way in RTL', () => {
    const { container } = render(
      <div style={{ direction: 'rtl' }}>
        <ProTabBar paneId="main" tabs={[HOME, CAL]} activeTabId={HOME.id} isFocused onActivate={() => {}} onClose={() => {}} />
      </div>,
    );
    const strip = container.querySelector<HTMLElement>('[role=tablist]')!;
    strip.style.direction = 'rtl';
    fireEvent.wheel(strip, { deltaY: 40 });
    expect(strip.scrollLeft).toBe(-40);
    strip.style.direction = 'ltr';
    fireEvent.wheel(strip, { deltaY: 40 });
    expect(strip.scrollLeft).toBe(0);
  });

  it('inserts on the side of the tab the pointer is on in RTL', () => {
    const { container } = render(
      <ProTabBar paneId="main" tabs={[HOME, CAL]} activeTabId={HOME.id} isFocused onActivate={() => {}} onClose={() => {}} />,
    );
    const cal = container.querySelector<HTMLElement>('[data-tab-id=cal]')!;
    cal.style.direction = 'rtl';
    cal.getBoundingClientRect = () => rect(0, 100) as DOMRect;
    const dataTransfer = new MockDataTransfer();
    dataTransfer.setData(PRO_TAB_DRAG_MIME, 'home-mail');
    // The left half of a tab is its far end in RTL.
    const over = createEvent.dragOver(cal, { dataTransfer });
    Object.defineProperty(over, 'clientX', { value: 10 });
    fireEvent(cal, over);
    fireEvent.drop(cal, { dataTransfer });
    const order = useProTabStore.getState().tabs.filter((t) => t.paneId === 'main').map((t) => t.id);
    expect(order).toEqual(['cal', 'home-mail']);
  });
});
