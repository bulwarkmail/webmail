import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from '../use-keyboard-shortcuts';

// MO-05: with focus inside the shortcuts help or the Create folder dialog,
// Delete, #, e, j, k and ArrowDown acted on the message behind the dialog.
// MO-04: single-character shortcuts can be turned off (WCAG 2.1.4).

function handlers() {
  return {
    onDelete: vi.fn(),
    onArchive: vi.fn(),
    onNextEmail: vi.fn(),
    onPreviousEmail: vi.fn(),
    onCompose: vi.fn(),
    onSelectAll: vi.fn(),
    onGoToMailbox: vi.fn(),
    onShowHelp: vi.fn(),
    onCloseEmail: vi.fn(),
  };
}
type Handlers = ReturnType<typeof handlers>;

function press(target: EventTarget, key: string, code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function mount(attrs: Record<string, string>) {
  const layer = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) layer.setAttribute(k, v);
  const button = document.createElement('button');
  layer.appendChild(button);
  document.body.appendChild(layer);
  return button;
}

function messageList() {
  const list = document.createElement('div');
  list.id = 'message-list';
  list.tabIndex = -1;
  document.body.appendChild(list);
  return list;
}

const KEYS: [string, string, KeyboardEventInit, keyof Handlers][] = [
  ['Delete', 'Delete', {}, 'onDelete'],
  ['#', 'Digit3', { shiftKey: true }, 'onDelete'],
  ['e', 'KeyE', {}, 'onArchive'],
  ['j', 'KeyJ', {}, 'onNextEmail'],
  ['k', 'KeyK', {}, 'onPreviousEmail'],
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useKeyboardShortcuts: open dialogs and menus own the keyboard', () => {
  it.each(KEYS)('ignores %s with focus in a modal dialog', (key, code, init, handler) => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const button = mount({ role: 'dialog', 'aria-modal': 'true' });
    press(button, key, code, init);
    expect(h[handler]).not.toHaveBeenCalled();
  });

  it('ignores ArrowDown in the list while a modal dialog is open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    mount({ role: 'dialog', 'aria-modal': 'true' });
    press(messageList(), 'ArrowDown', 'ArrowDown');
    expect(h.onNextEmail).not.toHaveBeenCalled();
  });

  it('ignores keys while a menu is open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const item = mount({ role: 'menu' });
    press(item, 'Delete', 'Delete');
    press(document, 'e', 'KeyE');
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(h.onArchive).not.toHaveBeenCalled();
  });

  it('ignores keys while a listbox popup is expanded', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    mount({ 'aria-haspopup': 'listbox', 'aria-expanded': 'true' });
    press(document, 'j', 'KeyJ');
    expect(h.onNextEmail).not.toHaveBeenCalled();
  });

  it('does not count a hidden menu as open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const wrapper = document.createElement('div');
    wrapper.setAttribute('hidden', '');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    wrapper.appendChild(menu);
    document.body.appendChild(wrapper);
    press(document, 'e', 'KeyE');
    expect(h.onArchive).toHaveBeenCalledTimes(1);
  });

  it('ignores an event someone already handled', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('keydown', (e) => e.preventDefault());
    press(el, 'Delete', 'Delete');
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it('still acts when nothing is open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    press(document, 'Delete', 'Delete');
    press(document, 'e', 'KeyE');
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onArchive).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: arrows only in the message list', () => {
  it('leaves ArrowDown alone outside the list', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const reader = document.createElement('div');
    reader.tabIndex = 0;
    document.body.appendChild(reader);
    const event = press(reader, 'ArrowDown', 'ArrowDown');
    expect(h.onNextEmail).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('moves with ArrowDown from inside the list', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const list = messageList();
    const checkbox = document.createElement('span');
    list.appendChild(checkbox);
    press(checkbox, 'ArrowDown', 'ArrowDown');
    expect(h.onNextEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps j working page-wide', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    press(document, 'j', 'KeyJ');
    expect(h.onNextEmail).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: single-key shortcuts off', () => {
  it.each([
    ['j', 'KeyJ', {}, 'onNextEmail'],
    ['e', 'KeyE', {}, 'onArchive'],
    ['#', 'Digit3', { shiftKey: true }, 'onDelete'],
    ['c', 'KeyC', {}, 'onCompose'],
    ['?', 'Slash', { shiftKey: true }, 'onShowHelp'],
  ] as [string, string, KeyboardEventInit, keyof Handlers][])('turns off %s', (key, code, init, handler) => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', singleKeyShortcuts: false, handlers: h }));
    press(document, key, code, init);
    expect(h[handler]).not.toHaveBeenCalled();
  });

  it('turns off the g sequences', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], mountainViewKeys: true, singleKeyShortcuts: false, handlers: h }));
    press(document, 'g', 'KeyG');
    press(document, 'i', 'KeyI');
    expect(h.onGoToMailbox).not.toHaveBeenCalled();
  });

  it('keeps Delete, Escape, arrows in the list and Ctrl+A', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', singleKeyShortcuts: false, handlers: h }));
    const list = messageList();
    press(document, 'Delete', 'Delete');
    press(document, 'Escape', 'Escape');
    press(list, 'ArrowDown', 'ArrowDown');
    press(document, 'a', 'KeyA', { ctrlKey: true });
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onCloseEmail).toHaveBeenCalledTimes(1);
    expect(h.onNextEmail).toHaveBeenCalledTimes(1);
    expect(h.onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the g sequences with the setting on', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], mountainViewKeys: true, singleKeyShortcuts: true, handlers: h }));
    press(document, 'g', 'KeyG');
    press(document, 'i', 'KeyI');
    expect(h.onGoToMailbox).toHaveBeenCalledWith('inbox');
  });
});


it('blocks mailbox actions while a marked disclosure is open, and restores them when closed',()=>{
  const h = handlers();
  renderHook(()=>useKeyboardShortcuts({emails:[],selectedEmailId:'e1',handlers:h}));
  const details = document.createElement('details');
  details.setAttribute('data-keyboard-layer','');
  const summary = document.createElement('summary'); summary.textContent='Workspace preferences';
  details.append(summary); document.body.append(details);
  details.open=true;
  press(summary,'Delete','Delete');
  press(summary,'e','KeyE');
  expect(h.onDelete).not.toHaveBeenCalled(); expect(h.onArchive).not.toHaveBeenCalled();
  details.open=false;
  press(document,'Delete','Delete');
  expect(h.onDelete).toHaveBeenCalledOnce();
});
