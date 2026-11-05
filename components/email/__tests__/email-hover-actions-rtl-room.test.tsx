import { Profiler } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';
import { EmailHoverActions } from '../email-hover-actions';

vi.mock('@/components/plugins/plugin-actions', () => ({
  PluginActions: () => null,
  usePluginActions: () => [],
  useMessageActionTarget: () => ({ accountKind: 'personal', keywords: [] }),
}));

// mail-p3-10: in Arabic the row's hover actions sit at its left end, which is
// where a left-aligned English subject is, and hid it on the hovered row. The
// strip now tells the row how wide it is while it shows, and right to left the
// row's text keeps clear of it by that much.

const email = { id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;
const width = { value: 0 };

beforeEach(() => {
  useSettingsStore.setState({ hoverActions: ['delete', 'star'], interfaceLayout: 'default', hoverActionsMode: 'inline' } as never);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-hover-strip') ? width.value : 0;
  });
});
afterEach(() => vi.restoreAllMocks());

function row() {
  const view = render(
    <div data-menu-row="">
      <div role="gridcell" data-row-text="">Quarterly report</div>
      <div role="gridcell"><EmailHoverActions email={email} onDelete={vi.fn()} onToggleStar={vi.fn()} /></div>
    </div>,
  );
  return { ...view, el: view.container.querySelector('[data-menu-row]') as HTMLElement };
}

describe('the room a row keeps for its hover actions', () => {
  it('is the shown strip width, set on the row', () => {
    width.value = 132;
    const { el } = row();
    expect(el.hasAttribute('data-hover-actions-shown')).toBe(true);
    expect(el.style.getPropertyValue('--row-actions-w')).toBe('132px');
  });

  it('is nothing while the strip is hidden, and goes with it', () => {
    width.value = 0;
    const { el, unmount } = row();
    expect(el.hasAttribute('data-hover-actions-shown')).toBe(false);
    width.value = 132;
    const again = row();
    unmount();
    again.unmount();
    expect(again.el.hasAttribute('data-hover-actions-shown')).toBe(false);
  });

  it('costs a mounting row no second render pass', () => {
    // A search mounts a list of new rows: the strip used to keep its element
    // in state, so each mount committed twice (perf guard, search).
    width.value = 132;
    const commits: string[] = [];
    const view = render(
      <Profiler id="row" onRender={(_id, phase) => commits.push(phase)}>
        <div data-menu-row="">
          <div role="gridcell"><EmailHoverActions email={email} onDelete={vi.fn()} onToggleStar={vi.fn()} /></div>
        </div>
      </Profiler>,
    );
    expect(commits).toEqual(['mount']);
    expect(view.container.querySelector('[data-menu-row]')!.hasAttribute('data-hover-actions-shown')).toBe(true);
  });

  it('keeps right-to-left text clear of the strip', () => {
    const css = readFileSync(path.resolve(__dirname, '../../../app/globals.css'), 'utf8');
    const rule = css.match(/html\[dir="rtl"\] \[data-menu-row\]\[data-hover-actions-shown\] > \[data-row-text\] \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/padding-inline-end:\s*calc\(var\(--row-actions-w/);
  });

  it('marks the text cell of both list rows', () => {
    const source = readFileSync(path.resolve(__dirname, '../thread-list-item.tsx'), 'utf8');
    expect(source.match(/role="gridcell"\s+data-row-text=""\s+className=\{cn\('px-3'/g)).toHaveLength(2);
  });
});
