import { describe, it, expect, afterEach, vi } from 'vitest';

import { isEditableEventTarget, readKeyboardLayoutMap, resetKeyboardLayout, shortcutKey } from '../keyboard';

// Regression tests for #654: global single-key shortcuts fired while the user
// was editing inside the QuotedHtml shadow-DOM island, because the shadow
// boundary retargets both document.activeElement and event.target to the
// plain-div host. isEditableEventTarget must rely on composedPath instead.

// Evaluate from a window-level listener DURING dispatch — composedPath() is
// only populated while the event is being dispatched, matching how the real
// shortcut handlers run.
function dispatchAndCheck(el: HTMLElement): { editable: boolean; target: EventTarget | null } {
  let result: { editable: boolean; target: EventTarget | null } | null = null;
  const listener = (e: Event) => {
    result = { editable: isEditableEventTarget(e), target: e.target };
  };
  window.addEventListener('keydown', listener);
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, composed: true })
  );
  window.removeEventListener('keydown', listener);
  if (!result) throw new Error('keydown never reached window');
  return result;
}

describe('isEditableEventTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('detects plain inputs and textareas', () => {
    for (const tag of ['input', 'textarea', 'select'] as const) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      expect(dispatchAndCheck(el).editable).toBe(true);
    }
  });

  it('detects a contentEditable element', () => {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    document.body.appendChild(el);
    expect(dispatchAndCheck(el).editable).toBe(true);
  });

  it('returns false for a non-editable element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(dispatchAndCheck(el).editable).toBe(false);
  });

  it('sees through a shadow boundary to an inner contentEditable (QuotedHtml island)', () => {
    // Mirror the structure quoted-html.ts builds: plain-div host, open shadow
    // root, inner contentEditable div.
    const host = document.createElement('div');
    host.className = 'quoted-html-island';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.setAttribute('contenteditable', 'true');
    shadow.appendChild(inner);

    const { editable, target } = dispatchAndCheck(inner);
    // Sanity: the shadow boundary retargets the event — the outside listener
    // sees the host, which is exactly why a target/activeElement check fails.
    expect(target).toBe(host);
    expect(editable).toBe(true);
  });

  it('still returns false for a non-editable shadow tree', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    shadow.appendChild(inner);

    expect(dispatchAndCheck(inner).editable).toBe(false);
  });
});

// #1714: a shortcut is the key the user types. Colemak types "e" on the key
// a US keyboard has F on; that is "e", not "f".
describe('shortcutKey', () => {
  const press = (key: string, code: string, shiftKey = false) => ({ key, code, shiftKey });

  it('takes the typed letter on Latin layouts', () => {
    expect(shortcutKey(press('e', 'KeyF'))).toBe('e'); // Colemak
    expect(shortcutKey(press('a', 'KeyQ'))).toBe('a'); // AZERTY
    expect(shortcutKey(press('R', 'KeyO', true))).toBe('r'); // Dvorak, Shift
  });

  it('takes the typed sign, wherever the layout has it', () => {
    expect(shortcutKey(press('/', 'Period', true))).toBe('/'); // AZERTY Shift + :
    expect(shortcutKey(press('!', 'Slash'))).toBe('!'); // AZERTY
    expect(shortcutKey(press('?', 'Slash', true))).toBe('?');
  });

  it('falls back to the US place where the layout types no Latin character', () => {
    expect(shortcutKey(press('у', 'KeyE'))).toBe('e'); // Russian
    expect(shortcutKey(press('ε', 'KeyE'))).toBe('e'); // Greek
    expect(shortcutKey(press('ק', 'KeyE'))).toBe('e'); // Hebrew
    expect(shortcutKey(press('Å', 'KeyA', true))).toBe('a'); // macOS Option + Shift + A
    expect(shortcutKey(press('Dead', 'KeyE'))).toBe('e'); // macOS Option + E
    expect(shortcutKey(press('№', 'Digit3', true))).toBe('#'); // Russian Shift + 3
  });

  it('keeps named keys', () => {
    expect(shortcutKey(press('ArrowDown', 'ArrowDown'))).toBe('arrowdown');
    expect(shortcutKey(press('Delete', 'Delete'))).toBe('delete');
  });
});

// #1719: a Mac's Option layer types no letter, so the key's place stood in,
// which on Colemak is another letter: Option+Shift+N went by the US N key.
describe('shortcutKey with the Option layer on a non-QWERTY layout', () => {
  afterEach(() => { resetKeyboardLayout(); vi.unstubAllGlobals(); });
  const option = (key: string, code: string) => ({ key, code, shiftKey: true });

  it('takes the letter the key typed when last pressed without a modifier', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyJ' })); // Colemak
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', code: 'KeyN', shiftKey: true }));
    expect(shortcutKey(option('Dead', 'KeyJ'))).toBe('n');
    expect(shortcutKey(option('˜', 'KeyN'))).toBe('k');
  });

  it('learns nothing from a press with Option, Ctrl or ⌘, or from a dead key', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyJ', altKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyJ', metaKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyJ' }));
    expect(shortcutKey(option('Dead', 'KeyJ'))).toBe('j');
  });

  it('goes back to the US place once the key types a non-Latin letter', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyJ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'о', code: 'KeyJ' })); // switched to Russian
    expect(shortcutKey(option('Dead', 'KeyJ'))).toBe('j');
  });

  it('reads the layout from the browser where it has a layout map', async () => {
    vi.stubGlobal('navigator', { ...navigator, keyboard: {
      getLayoutMap: async () => new Map([['KeyJ', 'n'], ['KeyE', 'f'], ['KeyK', 'л']]),
    } });
    await readKeyboardLayoutMap();
    expect(shortcutKey(option('Dead', 'KeyJ'))).toBe('n');
    expect(shortcutKey(option('´', 'KeyE'))).toBe('f');
    expect(shortcutKey(option('Dead', 'KeyK'))).toBe('k');
  });

  it('still takes the typed letter first', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyJ' }));
    expect(shortcutKey(option('J', 'KeyJ'))).toBe('j');
  });
});
