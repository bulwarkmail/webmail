import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RowTags } from '../row-tags';
import { KEYWORD_PALETTE, useSettingsStore } from '@/stores/settings-store';
import { TagScopeContext, type TagScope } from '@/hooks/use-account-tags';
import { resetSharedTags, sharedTagsKey, useSharedTagsStore } from '@/stores/shared-tags-store';

const { labelNodes } = vi.hoisted(() => ({ labelNodes: new Set<HTMLElement>() }));
// Isolate the fitter subscriptions. This also detects hook-bearing sizing
// copies: the shortening hook must only attach to visible badges.
vi.mock('@/hooks/use-shortened-text', () => ({
  useShortenedText: (candidates: string[]) => [(node: HTMLElement | null) => {
    if (node) labelNodes.add(node);
  }, candidates[0]],
}));

let laneWidth: number;
let scale: number;
let fonts: EventTarget;
let fontDescriptor: PropertyDescriptor | undefined;
let resizeObservers: TestResizeObserver[];
let mutationsCreated: number;
let mutationsDisconnected: number;
class TestResizeObserver {
  targets = new Set<Element>();
  disconnected = false;
  constructor(public callback: ResizeObserverCallback) { resizeObservers.push(this); }
  observe(element: Element) { this.targets.add(element); }
  unobserve(element: Element) { this.targets.delete(element); }
  disconnect() { this.disconnected = true; this.targets.clear(); }
}
const tags = ['work', 'green', 'long'];
const settle = () => act(async () => {});
const widthOf = (container: HTMLElement) => parseFloat(container.querySelector<HTMLElement>('[data-row-tags]')!.style.width);
const visible = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-tag-visible]')!;

beforeEach(() => {
  laneWidth = 300;
  scale = 1;
  labelNodes.clear();
  resizeObservers = [];
  mutationsCreated = mutationsDisconnected = 0;
  resetSharedTags();
  useSettingsStore.setState({ emailKeywords: [
    { id: 'work', label: 'Work', color: 'red' },
    { id: 'green', label: 'Green', color: 'green' },
    { id: 'long', label: 'InternationalInfrastructureModernizationProject', color: 'blue' },
  ], nestedTags: false, showColorNames: false });
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const NativeMutationObserver = globalThis.MutationObserver;
  vi.stubGlobal('MutationObserver', class extends NativeMutationObserver {
    constructor(callback: MutationCallback) { super(callback); mutationsCreated++; }
    disconnect() { mutationsDisconnected++; super.disconnect(); }
  });
  fontDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  fonts = new EventTarget();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = originalStyle(element);
    Object.defineProperties(style, { columnGap: { configurable: true, value: '4px' },
      fontSize: { configurable: true, value: `${11 * scale}px` },
      maxWidth: { configurable: true, value: 'none' } });
    return style;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return (this.textContent?.length ?? 0) * 7 * scale;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    let width = parseFloat(this.style.width) || 0;
    if (this.hasAttribute('data-lane')) width = laneWidth;
    if (this.hasAttribute('data-tag-controls')) width = (this.textContent?.length ?? 0) * 7;
    if (this.parentElement?.hasAttribute('data-tag-measure')) {
      width = this.hasAttribute('data-tag-dot') ? 16 * scale : Math.min(192 * scale, this.title.length * 7 * scale + 18);
    }
    if (this.classList.contains('truncate') && this.closest('[data-tag-measure]')) {
      width = Math.min(192 * scale, this.parentElement!.title.length * 7 * scale + 18) - 18;
    }
    return { width, height: 22 * scale } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (fontDescriptor) Object.defineProperty(document, 'fonts', fontDescriptor);
  else Reflect.deleteProperty(document, 'fonts');
  resetSharedTags();
});

function Lane({ sender = 'Alice', ids = tags, scope, control = '', status = false, variant = 'badge' as const, unrelated = 0 }: {
  sender?: string; ids?: string[]; scope?: TagScope | null; control?: string; status?: boolean;
  variant?: 'badge' | 'dot'; unrelated?: number;
}) {
  return <div data-lane="" data-unrelated={unrelated}>
    <span data-tag-text="">{sender}</span>
    {status && <span data-status="" style={{ width: 30 }}>status</span>}
    <RowTags tagIds={[...ids]} variant={variant} scope={scope ? { ...scope } : scope}
      leading={control ? <span>{control}</span> : undefined} />
  </div>;
}

describe('RowTags sizing and subscription lifetime (mocked geometry)', () => {
  it('uses hook-free samples of the same badge markup and keeps subscriptions on unrelated renders', async () => {
    const { container, unmount } = render(<Lane />);
    await settle();
    expect(labelNodes.size).toBeGreaterThan(0);
    expect([...labelNodes].every(node => !node.closest('[data-tag-measure]'))).toBe(true);
    const work = container.querySelector<HTMLElement>('[data-tag-measure="named"] [title="Work"]')!;
    const shownWork = visible(container).querySelector<HTMLElement>('[title="Work"]')!;
    const shape = (node: HTMLElement) => node.className.split(' ').filter(name => !name.startsWith('max-w-')).join(' ');
    expect(shape(work)).toBe(shape(shownWork));
    expect(work.querySelector('.truncate')).toHaveTextContent('Work');
    unmount();
  });

  it('keeps observer instances and measurements stable across unrelated renders, and cleans up', async () => {
    const { rerender, unmount } = render(<Lane />);
    await settle();
    const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length;
    for (let unrelated = 1; unrelated <= 5; unrelated++) rerender(<Lane unrelated={unrelated} />);
    await settle();
    expect(resizeObservers).toHaveLength(1);
    expect(mutationsCreated).toBe(1);
    expect(mutationsDisconnected).toBe(0);
    expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length).toBe(reads);
    unmount();
    expect(resizeObservers[0].disconnected).toBe(true);
    expect(mutationsDisconnected).toBe(1);
  });

  it('invalidates intrinsic sender text, added/removed controls and equal-width text changes without replacing observers', async () => {
    const { container, rerender } = render(<Lane />);
    const short = widthOf(container);
    rerender(<Lane sender={'UnbrokenSender'.repeat(30)} />);
    // The committed DOM must be fitted before a later MutationObserver turn.
    expect(widthOf(container)).toBeLessThan(short);
    await settle();
    expect(widthOf(container)).toBeLessThan(short);
    expect(visible(container).querySelectorAll('[data-tag-dot]')).toHaveLength(3);
    rerender(<Lane sender="Alice" status control="12" />);
    await settle();
    const withControls = widthOf(container);
    const status = container.querySelector('[data-status]')!;
    expect(resizeObservers[0].targets.has(status)).toBe(true);
    rerender(<Lane sender="Alice" />);
    await settle();
    expect(resizeObservers[0].targets.has(status)).toBe(false);
    expect(widthOf(container)).not.toBe(withControls);
    expect(resizeObservers).toHaveLength(1);
    expect(mutationsCreated).toBe(1);
  });

  it('refits tag/variant/settings changes, including removal and subsequent addition', async () => {
    const { container, rerender } = render(<Lane />);
    act(() => useSettingsStore.getState().updateKeyword('work', { label: 'Renamed account tag' }));
    expect(container.querySelector('[data-tag-measure="named"]')).toHaveTextContent('Renamed account tag');
    expect(container.querySelector('[data-row-tags]')).toHaveAccessibleName(/Renamed account tag/);
    act(() => useSettingsStore.setState({ showColorNames: true }));
    expect(container.querySelector('[data-tag-measure="compact"] [data-tag-dot]')).toBeNull();
    expect(visible(container).querySelector('[data-tag-dot]')).toBeNull();
    act(() => useSettingsStore.setState({ showColorNames: false }));
    rerender(<Lane ids={['green']} variant="dot" />);
    await settle();
    expect(visible(container).querySelectorAll('[data-tag-dot]')).toHaveLength(1);
    expect(container.querySelector('[data-row-tags]')).toHaveAccessibleName('Green');
    expect(resizeObservers).toHaveLength(1);
    rerender(<Lane ids={[]} />);
    expect(resizeObservers[0].disconnected).toBe(true);
    expect(mutationsDisconnected).toBe(1);
    rerender(<Lane ids={tags} />);
    await settle();
    expect(resizeObservers).toHaveLength(2);
    expect(container.querySelector('[data-row-tags]')).toHaveAccessibleName(/Renamed account tag/);
  });

  it('measures scoped definitions and tracks scope arrival/switch without personal-label samples', async () => {
    const scope = { loginId: 'fixture-login', accountId: 'team' };
    useSharedTagsStore.setState({ entries: { [sharedTagsKey(scope.loginId, scope.accountId)]: {
      status: 'ready', tags: [{ id: 'work', label: 'Team label', color: 'blue' }], stored: null, pending: [],
      discovered: {}, loadedAt: 1, discoveredAt: 1, readFailedAt: null,
    } } });
    const { container, rerender } = render(<TagScopeContext.Provider value={scope}><Lane ids={['work']} /></TagScopeContext.Provider>);
    expect(container.querySelector('[data-row-tags]')).toHaveAccessibleName('Team label');
    expect(container.querySelector('[data-tag-measure="named"] [title="Team label"]')).toHaveClass(KEYWORD_PALETTE.blue.fill);
    rerender(<TagScopeContext.Provider value={scope}><Lane ids={['work']} scope={null} /></TagScopeContext.Provider>);
    await settle();
    expect(container.querySelector('[data-row-tags]')).toHaveAccessibleName('Work');
    expect(container.querySelector('[data-tag-measure="named"] [title="Team label"]')).toBeNull();
    expect(resizeObservers).toHaveLength(1);
  });

  it('restores names after resize and invalidates inherited styles, sample sizes and loaded fonts, with cleanup', async () => {
    const add = vi.spyOn(fonts, 'addEventListener');
    const remove = vi.spyOn(fonts, 'removeEventListener');
    const { container, unmount } = render(<Lane sender={'Unbroken'.repeat(10)} />);
    laneWidth = 2400;
    act(() => resizeObservers[0].callback([], resizeObservers[0] as unknown as ResizeObserver));
    expect(visible(container).querySelector('[data-tag-dot]')).toBeNull();
    const normal = widthOf(container);
    scale = 1.25;
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    expect(widthOf(container)).toBeGreaterThan(normal);
    scale = 1;
    await act(async () => { document.body.style.fontSize = '14px'; });
    expect(widthOf(container)).toBe(normal);
    scale = 1.25;
    act(() => resizeObservers[0].callback([], resizeObservers[0] as unknown as ResizeObserver));
    expect(widthOf(container)).toBeGreaterThan(normal);
    expect(resizeObservers).toHaveLength(1);
    expect(mutationsCreated).toBe(1);
    unmount();
    expect(mutationsDisconnected).toBe(1);
    expect(remove.mock.calls).toEqual(add.mock.calls);
    const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length;
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length).toBe(reads);
    document.body.style.fontSize = '';
  });
});
