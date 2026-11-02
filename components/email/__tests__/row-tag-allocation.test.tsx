import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { ThreadEmailItem } from '../thread-email-item';
import { TagDisplayContext } from '@/hooks/use-tag-display';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import { useEmailStore } from '@/stores/email-store';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null, client: null, activeAccountId: null, getClientForAccount: () => undefined };
  return { useAuthStore: Object.assign((selector?: (value: typeof state) => unknown) => selector ? selector(state) : state, { getState: () => state }) };
});
vi.mock('@/stores/account-store', () => {
  const account = { id: 'audit-a', avatarColor: '#0d9488', email: 'a@example.invalid' };
  const state = { accounts: [account, { ...account, id: 'audit-b' }], getAccountById: () => account };
  return { useAccountStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});

const definitions = ['Work', 'Orange', 'InternationalInfrastructureModernizationProject', 'QuarterlyRegulatoryComplianceReview'].map((label, index) => ({ id: `tag${index}`, label, color: 'red' as const }));
const senders = ['Alice', 'Alexandria Montgomery International Infrastructure Communications Department', 'AlexandriaMontgomeryInternationalInfrastructureCommunicationsDepartment'.repeat(3)];
let laneWidth: number;
const callbacks = new Set<ResizeObserverCallback>();
const rect = (width: number, height = 22) => ({ width, height } as DOMRect);

beforeEach(() => {
  laneWidth = 250;
  useSettingsStore.setState({ emailKeywords: definitions, mailLayout: 'split', interfaceLayout: 'default', showPreview: false, showColorNames: false, showAccountDot: true, tintListRowsByAccount: false, density: 'regular', listColumns: false });
  useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
  useEmailStore.setState({ selectedEmailKeys: new Set(), selectedMailbox: 'inbox', mailboxes: [{ id: 'inbox', role: 'inbox' } as never], isUnifiedView: true });
  // Deliberately mocked allocations: these verify fitting and containment
  // contracts, not actual CSS, visible rectangles, hit targets or painted pixels.
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) { callbacks.add(callback); }
    observe() {} unobserve() {} disconnect() { callbacks.delete(this.callback); }
  });
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = originalStyle(element);
    const gap = element.classList.contains('gap-0') ? 0 : element.classList.contains('gap-3') ? 12 : element.classList.contains('gap-2') ? 8 : element.classList.contains('gap-1.5') ? 6 : 4;
    Object.defineProperties(style, { columnGap: { value: `${gap}px`, configurable: true }, fontSize: { value: '11px', configurable: true }, maxWidth: { value: element.classList.contains('max-w-[150px]') ? '150px' : 'none', configurable: true }, marginInlineEnd: { value: element.classList.contains('me-2') ? '8px' : '0px', configurable: true } });
    return style;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return (this.textContent?.length ?? 0) * 7; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (Array.from(this.children).some(child => child.hasAttribute('data-row-tags'))) return rect(laneWidth);
    if (this.parentElement?.hasAttribute('data-tag-measure')) {
      return rect(this.hasAttribute('data-tag-dot') ? 16 : Math.min(192, this.title.length * 7 + 18));
    }
    if (this.classList.contains('truncate') && this.parentElement?.parentElement?.hasAttribute('data-tag-measure')) return rect(Math.min(192, this.parentElement.title.length * 7 + 18) - 18);
    if (this.hasAttribute('data-tag-controls')) return rect(this.querySelector('svg') ? 34 : 0);
    if (this.classList.contains('tabular-nums')) return rect(68);
    if (this.classList.contains('rounded-full') && this.style.backgroundColor) return rect(8, 8);
    if (this.querySelector('svg') && !this.hasAttribute('data-tag-text')) return rect(14);
    return rect(0);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); callbacks.clear(); });

function fixture(sender: string, count: number) {
  return Array.from({ length: count }, (_, index): Email => ({ id: `e${index}`, threadId: 'thread', from: [{ name: sender, email: 'fixture@example.invalid' }], mailboxIds: { inbox: true }, keywords: { $seen: true, ...Object.fromEntries(definitions.map(tag => [`$label:${tag.id}`, true])) }, subject: 'Subject', preview: 'Preview', size: 1024, receivedAt: '2026-01-15T10:00:00Z', hasAttachment: false, accountId: 'audit-a', accountLabel: 'Audit A' }));
}
const modes = ['split', 'subject', 'focus', 'columns', 'mountain', 'mountain-mobile', 'child', 'child-columns'] as const;
type Mode = typeof modes[number];
function row(sender: string, count: number, mode: Mode, rtl = false, toggle = vi.fn()) {
  useSettingsStore.setState({ mailLayout: ['focus', 'columns', 'mountain', 'child-columns'].includes(mode) ? 'focus' : 'split', interfaceLayout: mode.startsWith('mountain') ? 'mountain-view' : 'default', listColumns: mode === 'columns' || mode === 'child-columns' });
  useUIStore.setState({ isMobile: mode === 'mountain-mobile' });
  const emails = fixture(sender, count);
  return <div dir={rtl ? 'rtl' : 'ltr'}><TagDisplayContext.Provider value={{ variant: 'badge', placement: mode === 'subject' ? 'subject' : 'sender' }}>
    {mode.startsWith('child') ? <ThreadEmailItem email={emails[0]} /> : <ThreadListItem thread={groupEmailsByThread(emails)[0]} isExpanded={false} onToggleExpand={toggle} onEmailSelect={() => {}} />}
  </TagDisplayContext.Provider></div>;
}
function visibleTags(container: HTMLElement) {
  const visible = container.querySelector('[data-tag-visible]');
  return Array.from((visible ?? container).querySelectorAll<HTMLElement>('[title]')).filter(tag => definitions.some(definition => definition.label === tag.title));
}
const resize = (width: number) => act(() => { laneWidth = width; [...callbacks].forEach(callback => callback([], {} as ResizeObserver)); });

describe('row tag allocation wiring (not browser geometry)', () => {
  it.each(modes.flatMap(mode => senders.map((sender, index) => ({ mode, sender, kind: ['short', 'long', 'unbroken'][index] }))))('$mode / $kind sender retains compact tags and restores names', ({ mode, sender }) => {
      const { container, unmount } = render(row(sender, 3, mode));
      expect(visibleTags(container).length).toBeGreaterThan(0);
      expect(visibleTags(container).some(tag => tag.hasAttribute('data-tag-dot'))).toBe(true);
      const group = container.querySelector<HTMLElement>('[data-row-tags]')!;
      expect(group).toHaveAccessibleName(definitions.map(tag => tag.label).join(', '));
      expect(group).toHaveClass('overflow-hidden');
      expect(group.parentElement).toHaveClass('overflow-hidden');
      expect(parseFloat(group.style.width)).toBeLessThanOrEqual(laneWidth);
      resize(2400);
      expect(visibleTags(container)).toHaveLength(4);
      expect(visibleTags(container).some(tag => tag.hasAttribute('data-tag-dot'))).toBe(false);
      resize(250);
      expect(visibleTags(container).some(tag => tag.hasAttribute('data-tag-dot'))).toBe(true);
      unmount();
  });

  it.each([1, 3])('keeps account/date/count/expand controls outside the hideable tag suffix (%s messages)', count => {
    const toggle = vi.fn();
    const { container } = render(row(senders[2], count, 'split', false, toggle));
    const group = container.querySelector('[data-row-tags]')!;
    expect(group).not.toBeNull();
    const visible = group.querySelector('[data-tag-visible]')!;
    expect(container.querySelector('[title="Audit A, a@example.invalid"]')).not.toBeNull();
    const date = container.querySelector('.tabular-nums')!;
    expect(group.contains(date)).toBe(false);
    expect(date.parentElement).toHaveClass('flex-shrink-0');
    if (count === 3) {
      expect(group.querySelector('[data-tag-controls]')).toHaveTextContent('3');
      expect(visible.textContent).not.toContain('3');
      fireEvent.click(container.querySelector('[data-expand-toggle]')!);
      expect(toggle).toHaveBeenCalledOnce();
    }
    resize(12);
    expect(visibleTags(container)).toHaveLength(0);
    expect(group).toHaveAttribute('data-tag-space', 'insufficient');
    expect(group).toHaveAccessibleName(definitions.map(tag => tag.label).join(', '));
  });

  it('keeps complete dots, handles tag removal/rename and preserves labelled compact names', () => {
    const { container, rerender } = render(row(senders[2], 1, 'split'));
    const group = container.querySelector('[data-row-tags]')!;
    resize(74); // account + three lane gaps leave fewer than four whole dots.
    expect(visibleTags(container).length).toBeLessThan(4);
    expect(visibleTags(container).every(tag => tag.hasAttribute('data-tag-dot'))).toBe(true);
    resize(250);
    act(() => useSettingsStore.getState().updateKeyword('tag0', { label: 'Renamed Work' }));
    expect(group).toHaveAccessibleName(/Renamed Work/);
    act(() => useSettingsStore.setState({ showColorNames: true }));
    expect(visibleTags(container).length).toBeGreaterThan(0);
    expect(visibleTags(container).every(tag => !tag.hasAttribute('data-tag-dot'))).toBe(true);
    const emails = fixture('Alice', 1);
    emails[0].keywords = { '$label:tag0': true };
    rerender(<TagDisplayContext.Provider value={{ variant: 'badge', placement: 'sender' }}><ThreadListItem thread={groupEmailsByThread(emails)[0]} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} /></TagDisplayContext.Provider>);
    expect(container.querySelector('[data-row-tags]')).toHaveAccessibleName('Renamed Work');
  });

  it('reallocates after account and status indicators change, without moving them into tags', async () => {
    const { container, rerender } = render(row(senders[0], 3, 'split'));
    const group = () => container.querySelector<HTMLElement>('[data-row-tags]')!;
    const before = parseFloat(group().style.width);
    await act(async () => { useEmailStore.setState({ isUnifiedView: false }); });
    expect(parseFloat(group().style.width)).toBeGreaterThan(before);
    const emails = fixture(senders[0], 3);
    emails[0].hasAttachment = true;
    const withoutStatus = parseFloat(group().style.width);
    rerender(<TagDisplayContext.Provider value={{ variant: 'badge', placement: 'sender' }}><ThreadListItem thread={groupEmailsByThread(emails)[0]} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} /></TagDisplayContext.Provider>);
    await act(async () => {}); // Deliver the lane mutation, as in the browser.
    expect(parseFloat(group().style.width)).toBeLessThan(withoutStatus);
    expect(group().querySelector('[data-tag-controls]')).toHaveTextContent('3');
    expect(container.querySelector('.tabular-nums')?.parentElement).toHaveClass('flex-shrink-0');
  });

  it.each([240, 319, 320, 400, 559, 560, 800])('uses the existing treatment at a %s px pane with an independently measured row lane', width => {
    // The pane selects placement/variant; its width is deliberately NOT the
    // mocked available row width (250), which already excludes date/gutters.
    const emails = fixture(senders[2], 3);
    const { container } = render(<TagDisplayContext.Provider value={{ variant: width < 320 ? 'dot' : 'badge', placement: width < 560 ? 'sender' : 'subject' }}><ThreadListItem thread={groupEmailsByThread(emails)[0]} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} /></TagDisplayContext.Provider>);
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-row-tags]'));
    expect(groups).toHaveLength(1);
    expect(visibleTags(container).length).toBeGreaterThan(0);
    expect(parseFloat(groups[0].style.width)).toBeLessThanOrEqual(laneWidth);
    if (width < 320) expect(visibleTags(container).every(tag => tag.hasAttribute('data-tag-dot'))).toBe(true);
    expect(groups[0].parentElement?.querySelector('[data-tag-text]')?.textContent).toContain(width < 560 ? senders[2] : 'Subject');
  });

  it.each([false, true])('uses logical lane widths with RTL=%s', rtl => {
    const { container } = render(row(senders[2], 3, 'split', rtl));
    expect(visibleTags(container)).toHaveLength(4);
    expect(visibleTags(container).every(tag => tag.hasAttribute('data-tag-dot'))).toBe(true);
    expect(container.firstElementChild).toHaveAttribute('dir', rtl ? 'rtl' : 'ltr');
    expect(container.querySelector('[data-row-tags]')).toHaveAccessibleName(definitions.map(tag => tag.label).join(', '));
  });
});
